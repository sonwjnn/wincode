import type { CredentialStore } from "@wincode/ai";

const credentialTypeFor = (credential: unknown): string => {
	if (typeof credential !== "object" || credential === null) {
		return "unknown";
	}
	if ("kind" in credential && typeof credential.kind === "string") {
		return credential.kind;
	}
	if ("type" in credential && typeof credential.type === "string") {
		return credential.type;
	}
	return "unknown";
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

const awaitWithSignal = async <Result>(
	operation: Promise<Result>,
	signal: AbortSignal | undefined
): Promise<Result> => {
	throwIfAborted(signal);
	if (signal === undefined) {
		return operation;
	}
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => {
		aborted.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([operation, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
};

export const createInMemoryCredentialStore = (
	credentials: Map<string, unknown>,
	beforeCredentialWrite?: (
		providerId: string,
		credential: unknown
	) => Promise<void>,
	beforeCredentialRead?: (providerId: string) => void
): CredentialStore => {
	const queues = new Map<string, Promise<void>>();
	const withLock = async <Result>(
		providerId: string,
		operation: () => Result | Promise<Result>,
		signal?: AbortSignal
	): Promise<Result> => {
		throwIfAborted(signal);
		const previous = queues.get(providerId) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		const queued = previous.catch(() => undefined).then(() => release.promise);
		queues.set(providerId, queued);
		void queued.then(() => {
			if (queues.get(providerId) === queued) {
				queues.delete(providerId);
			}
		});
		try {
			await awaitWithSignal(previous, signal);
			throwIfAborted(signal);
			return await operation();
		} finally {
			release.resolve();
		}
	};
	return {
		delete: async (providerId, { signal } = {}) => {
			await withLock(
				providerId,
				() => {
					credentials.delete(providerId);
				},
				signal
			);
		},
		list: () =>
			[...credentials].map(([providerId, credential]) => ({
				providerId,
				type: credentialTypeFor(credential),
			})),
		modify: (providerId, update, { signal } = {}) =>
			withLock(
				providerId,
				async () => {
					beforeCredentialRead?.(providerId);
					const current = credentials.get(providerId);
					const replacement = await update(current);
					if (replacement !== undefined) {
						await beforeCredentialWrite?.(providerId, replacement);
						credentials.set(providerId, replacement);
					}
					return credentials.get(providerId);
				},
				signal
			),
		read: (providerId, { signal } = {}) =>
			withLock(
				providerId,
				() => {
					beforeCredentialRead?.(providerId);
					return credentials.get(providerId);
				},
				signal
			),
	};
};
