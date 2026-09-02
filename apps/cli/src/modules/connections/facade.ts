import type { ConnectionProviderId } from "@wincode/ai/models";
import type {
	AuthorizationByProvider,
	ConnectionProviderSummary,
	Connections,
	ConnectRequest,
	CredentialByProvider,
	ProviderAdapterMap,
} from "./contract";
import { createProviderAdapters } from "./provider-adapters";
import { composeProviderServices, providerOrder } from "./provider-registry";
import {
	CredentialVaultV2,
	InvalidStoredConnectionError,
} from "./v2-credential-vault";

type ConnectionsFacadeDeps = {
	adapters: ProviderAdapterMap;
	vault: ConnectionsVault;
};
export type ConnectionsVault = {
	load<P extends ConnectionProviderId>(
		providerId: P
	): Promise<CredentialByProvider[P] | null>;
	replaceValidated<P extends ConnectionProviderId>(
		providerId: P,
		credential: CredentialByProvider[P]
	): Promise<void>;
};

type Service<P extends ConnectionProviderId> = {
	status(): Promise<ConnectionProviderSummary>;
	authorize(signal?: AbortSignal): Promise<AuthorizationByProvider[P]>;
	connect(request: ConnectRequest): Promise<void>;
};

export const createConnections = (
	deps: Partial<ConnectionsFacadeDeps> = {}
): Connections => {
	const vault = deps.vault ?? new CredentialVaultV2();
	const adapters = deps.adapters ?? createProviderAdapters({});
	const runQueued = async <T>(
		queue: { current?: Promise<void> },
		task: () => Promise<T>
	): Promise<T> => {
		const previous = queue.current ?? Promise.resolve();
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		queue.current = previous.then(
			() => current,
			() => current
		);
		await previous;
		try {
			return await task();
		} finally {
			release?.();
		}
	};
	const raceAbort = async <T>(
		promise: Promise<T>,
		signal: AbortSignal
	): Promise<T> => {
		if (signal.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) =>
				signal.addEventListener(
					"abort",
					() =>
						reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
					{ once: true }
				)
			),
		]);
	};

	type RuntimeAdapter<P extends ConnectionProviderId> = {
		status: (
			credential: CredentialByProvider[P] | null
		) => ConnectionProviderSummary;
		authorize: (
			credential: CredentialByProvider[P],
			signal?: AbortSignal
		) => Promise<{
			authorization: AuthorizationByProvider[P];
			replacementCredential?: CredentialByProvider[P];
		}>;
		connect: (request: ConnectRequest) => Promise<CredentialByProvider[P]>;
	};
	const toRuntimeAdapter = <P extends ConnectionProviderId>(
		adapter: ProviderAdapterMap[P]
	): RuntimeAdapter<P> => adapter as RuntimeAdapter<P>;
	const bind = <P extends ConnectionProviderId>(
		id: P,
		adapter: RuntimeAdapter<P>
	): Service<P> => {
		const queue: { current?: Promise<void> } = {};
		let authCache: Promise<AuthorizationByProvider[P]> | undefined;
		const authorize = async (
			signal?: AbortSignal
		): Promise<AuthorizationByProvider[P]> => {
			const pending =
				authCache ??
				runQueued(queue, async () => {
					const credential = await vault.load(id);
					if (credential === null) {
						throw new Error(
							`Reconnect ${adapter.status(null).displayName} with /connect`
						);
					}
					const result = await adapter.authorize(credential, undefined);
					if (result.replacementCredential !== undefined) {
						await vault.replaceValidated(id, result.replacementCredential);
					}
					return result.authorization;
				});
			authCache = pending;
			pending.then(
				() => {
					if (authCache === pending) {
						authCache = undefined;
					}
				},
				() => {
					if (authCache === pending) {
						authCache = undefined;
					}
				}
			);
			return signal ? await raceAbort(pending, signal) : await pending;
		};
		return {
			status: async () => {
				try {
					return adapter.status(await vault.load(id));
				} catch (error) {
					if (error instanceof InvalidStoredConnectionError) {
						return adapter.status(null);
					}
					throw error;
				}
			},
			authorize,
			connect: async (request) => {
				authCache = undefined;
				await runQueued(queue, async () => {
					const credential = await adapter.connect(request);
					request.signal?.throwIfAborted();
					await vault.replaceValidated(id, credential);
				});
			},
		};
	};
	const services = composeProviderServices<{
		[P in ConnectionProviderId]: Service<P>;
	}>(
		adapters,
		<P extends ConnectionProviderId>(id: P, adapter: ProviderAdapterMap[P]) =>
			bind(id, toRuntimeAdapter(adapter))
	);
	const authorize = async <P extends ConnectionProviderId>(
		id: P,
		signal?: AbortSignal
	) => services[id].authorize(signal);
	const connect = async (request: ConnectRequest): Promise<void> => {
		if (request.method === "browser") {
			request.onProgress?.("starting");
		}
		await services[request.providerId].connect(request);
		if (request.method === "browser") {
			request.onProgress?.("connected");
		}
	};
	return {
		listProviders: async () =>
			await Promise.all(providerOrder.map((id) => services[id].status())),
		connect,
		authorize,
	};
};
