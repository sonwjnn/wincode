import * as fs from "node:fs/promises";
import { withCrossProcessFileLock } from "./cross-process-file-lock";
import { isValidSecretKey } from "./secret-key";
import { readSecureJsonFile, writeSecureJsonFile } from "./secure-json-file";

type BunSecretStore = Partial<typeof Bun.secrets>;

const secretKeyQueues = new Map<string, Promise<void>>();
const fileWriteQueues = new Map<string, Promise<void>>();

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

const withQueueLock = async <Result>(
	queues: Map<string, Promise<void>>,
	key: string,
	operation: () => Result | Promise<Result>,
	signal?: AbortSignal
): Promise<Result> => {
	throwIfAborted(signal);
	const previous = queues.get(key) ?? Promise.resolve();
	const release = Promise.withResolvers<void>();
	const queued = previous.catch(() => undefined).then(() => release.promise);
	queues.set(key, queued);
	void queued.then(() => {
		if (queues.get(key) === queued) {
			queues.delete(key);
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

export type UserSecretStoreOperationOptions = Readonly<{
	signal?: AbortSignal;
}>;

export type UserSecretStore = Readonly<{
	delete: (
		key: string,
		options?: UserSecretStoreOperationOptions
	) => Promise<void>;
	get: (
		key: string,
		options?: UserSecretStoreOperationOptions
	) => Promise<string | undefined>;
	modify: (
		key: string,
		update: (
			value: string | undefined
		) => string | undefined | Promise<string | undefined>,
		options?: UserSecretStoreOperationOptions
	) => Promise<string | undefined>;
	set: (
		key: string,
		value: string,
		options?: UserSecretStoreOperationOptions
	) => Promise<void>;
}>;

export type UserSecretStoreOptions = Readonly<{
	accountPrefix: string;
	filePath: string;
	platformService: string;
	platformStore?: BunSecretStore | null;
	secretLabel: string;
	validateKey?: (key: string) => void;
}>;

const getBunSecretStore = (): BunSecretStore | undefined => {
	const bun = (
		globalThis as typeof globalThis & {
			Bun?: { secrets?: BunSecretStore };
		}
	).Bun;
	const store = bun?.secrets;
	return store?.get !== undefined && store.set !== undefined
		? store
		: undefined;
};

const readDocument = async (
	filePath: string,
	secretLabel: string
): Promise<Record<string, string>> => {
	const parsed = await readSecureJsonFile(filePath, secretLabel);
	if (parsed === undefined) {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid ${secretLabel} document: ${filePath}`);
	}
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string"
		)
	);
};

/** Creates one user-scoped, namespaced secret store with a secure file fallback. */
export const createUserSecretStore = ({
	accountPrefix,
	filePath,
	platformService,
	platformStore: providedPlatformStore,
	secretLabel,
	validateKey,
}: UserSecretStoreOptions): UserSecretStore => {
	const platformStore =
		providedPlatformStore === undefined
			? getBunSecretStore()
			: (providedPlatformStore ?? undefined);
	const accountFor = (key: string): string => `${accountPrefix}:${key}`;
	const assertKey = (key: string): void => {
		if (validateKey !== undefined) {
			validateKey(key);
			return;
		}
		if (!isValidSecretKey(key)) {
			throw new Error(`${secretLabel} keys must be short identifiers.`);
		}
	};
	const updateFileStore = async (
		update: (document: Record<string, string>) => void
	): Promise<void> =>
		withQueueLock(fileWriteQueues, filePath, () =>
			withCrossProcessFileLock(`${filePath}.file.lock`, async () => {
				const document = await readDocument(filePath, secretLabel);
				update(document);
				if (Object.keys(document).length === 0) {
					await fs.rm(filePath, { force: true });
				} else {
					await writeSecureJsonFile(filePath, document, secretLabel);
				}
			})
		);
	const readFileStore = async (key: string): Promise<string | undefined> =>
		(await readDocument(filePath, secretLabel))[key];
	const readValue = async (key: string): Promise<string | undefined> => {
		const fileValue = await readFileStore(key);
		if (fileValue !== undefined) {
			// A fallback write may be newer than a stale platform value after an outage.
			return fileValue;
		}
		const store = platformStore;
		if (store?.get !== undefined) {
			try {
				const value = await store.get({
					name: accountFor(key),
					service: platformService,
				});
				if (value !== null && value.length > 0) {
					return value;
				}
			} catch {
				// A failed read is not proof that the platform credential is absent.
			}
		}
		return;
	};
	const setValue = async (key: string, value: string): Promise<void> => {
		const store = platformStore;
		let storedOnPlatform = false;
		if (store?.set !== undefined) {
			try {
				await store.set({
					name: accountFor(key),
					service: platformService,
					value,
				});
				storedOnPlatform = true;
			} catch {
				// Keep the backend so later reads and deletes can retry after recovery.
			}
		}
		await updateFileStore((document) => {
			if (storedOnPlatform) {
				delete document[key];
			} else {
				document[key] = value;
			}
		});
	};
	const deleteValue = async (key: string): Promise<void> => {
		const store = platformStore;
		if (store !== undefined) {
			try {
				if (store.delete !== undefined) {
					await store.delete({
						name: accountFor(key),
						service: platformService,
					});
				} else if (store.set === undefined) {
					throw new Error(
						`The ${secretLabel} platform store does not support deletion.`
					);
				} else {
					await store.set({
						name: accountFor(key),
						service: platformService,
						value: "",
					});
				}
			} catch (error) {
				throw new Error(
					`Could not delete ${secretLabel} from the platform secret store.`,
					{ cause: error }
				);
			}
		}
		await updateFileStore((document) => {
			delete document[key];
		});
	};
	const lockKey = (key: string): string =>
		JSON.stringify([filePath, platformService, accountPrefix, key]);
	const lockPathFor = (key: string): string => {
		const digest = new Bun.CryptoHasher("sha256")
			.update(lockKey(key))
			.digest("hex");
		return `${filePath}.${digest}.lock`;
	};
	const withSecretLock = <Result>(
		key: string,
		operation: () => Result | Promise<Result>,
		signal?: AbortSignal
	): Promise<Result> =>
		withQueueLock(
			secretKeyQueues,
			lockKey(key),
			() => withCrossProcessFileLock(lockPathFor(key), operation, signal),
			signal
		);

	return Object.freeze({
		get(key, { signal } = {}) {
			assertKey(key);
			return withSecretLock(key, () => readValue(key), signal);
		},
		set(key, value, { signal } = {}) {
			assertKey(key);
			return withSecretLock(key, () => setValue(key, value), signal);
		},
		delete(key, { signal } = {}) {
			assertKey(key);
			return withSecretLock(key, () => deleteValue(key), signal);
		},
		modify(key, update, { signal } = {}) {
			assertKey(key);
			return withSecretLock(
				key,
				async () => {
					const current = await readValue(key);
					const replacement = await update(current);
					if (replacement === undefined) {
						return current;
					}
					await setValue(key, replacement);
					return replacement;
				},
				signal
			);
		},
	});
};
