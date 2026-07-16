import type { ConnectionProviderId } from "@wincode/ai";
import type {
	AuthorizationByProvider,
	ConnectionAuthorization,
	ConnectionProviderSummary,
	Connections,
	ConnectRequest,
	CredentialByProvider,
	ProviderAdapterMap,
} from "./contract";
import { createProviderAdapters } from "./provider-adapters";
import {
	CredentialVaultV2,
	InvalidStoredConnectionError,
} from "./v2-credential-vault";

type ConnectionsFacadeDeps = {
	adapters: ProviderAdapterMap;
	vault: ConnectionsVault;
};

export type ConnectionsVault = {
	load(
		providerId: "anthropic"
	): Promise<CredentialByProvider["anthropic"] | null>;
	load(providerId: "google"): Promise<CredentialByProvider["google"] | null>;
	load(providerId: "openai"): Promise<CredentialByProvider["openai"] | null>;
	load(providerId: "wincode"): Promise<CredentialByProvider["wincode"] | null>;
	replaceValidated(
		providerId: "anthropic",
		credential: CredentialByProvider["anthropic"]
	): Promise<void>;
	replaceValidated(
		providerId: "google",
		credential: CredentialByProvider["google"]
	): Promise<void>;
	replaceValidated(
		providerId: "openai",
		credential: CredentialByProvider["openai"]
	): Promise<void>;
	replaceValidated(
		providerId: "wincode",
		credential: CredentialByProvider["wincode"]
	): Promise<void>;
};

type ProviderQueues = Partial<Record<ConnectionProviderId, Promise<void>>>;
type Authorizers = {
	[P in ConnectionProviderId]: (
		signal?: AbortSignal
	) => Promise<AuthorizationByProvider[P]>;
};
type AuthCache = Partial<
	Record<ConnectionProviderId, Promise<ConnectionAuthorization>>
>;

export const createConnections = (
	deps: Partial<ConnectionsFacadeDeps> = {}
): Connections => {
	const vault = deps.vault ?? new CredentialVaultV2();
	const adapters = deps.adapters ?? createProviderAdapters({});
	const queues: ProviderQueues = {};
	const authCache: AuthCache = {};
	const authorizers: Authorizers = {
		anthropic: async () => {
			const credential = await vault.load("anthropic");
			if (credential === null) {
				throw new Error("Reconnect Anthropic with /connect");
			}
			return (await adapters.anthropic.authorize(credential)).authorization;
		},
		google: async () => {
			const credential = await vault.load("google");
			if (credential === null) {
				throw new Error("Reconnect Google with /connect");
			}
			return (await adapters.google.authorize(credential)).authorization;
		},
		openai: async (signal) => {
			const credential = await vault.load("openai");
			if (credential === null) {
				throw new Error("Reconnect OpenAI with /connect");
			}
			const result = await adapters.openai.authorize(credential, signal);
			if (result.replacementCredential !== undefined) {
				await vault.replaceValidated("openai", result.replacementCredential);
			}
			return result.authorization;
		},
		wincode: async (signal) => {
			const credential = await vault.load("wincode");
			if (credential === null) {
				throw new Error("Reconnect Wincode with /connect");
			}
			const result = await adapters.wincode.authorize(credential, signal);
			if (result.replacementCredential !== undefined) {
				await vault.replaceValidated("wincode", result.replacementCredential);
			}
			return result.authorization;
		},
	};

	const runQueued = async <T>(
		providerId: ConnectionProviderId,
		task: () => Promise<T>
	): Promise<T> => {
		const previous = queues[providerId] ?? Promise.resolve();
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		queues[providerId] = previous.then(
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

	const listProviders = async (): Promise<
		readonly ConnectionProviderSummary[]
	> =>
		Promise.all([
			loadProviderStatus("anthropic"),
			loadProviderStatus("google"),
			loadProviderStatus("openai"),
			loadProviderStatus("wincode"),
		]);

	const loadProviderStatus = async (
		providerId: ConnectionProviderId
	): Promise<ConnectionProviderSummary> => {
		try {
			switch (providerId) {
				case "anthropic":
					return adapters.anthropic.status(await vault.load("anthropic"));
				case "google":
					return adapters.google.status(await vault.load("google"));
				case "openai":
					return adapters.openai.status(await vault.load("openai"));
				case "wincode":
					return adapters.wincode.status(await vault.load("wincode"));
				default:
					throw new Error("Unknown provider.");
			}
		} catch (error) {
			if (error instanceof InvalidStoredConnectionError) {
				switch (providerId) {
					case "anthropic":
						return adapters.anthropic.status(null);
					case "google":
						return adapters.google.status(null);
					case "openai":
						return adapters.openai.status(null);
					case "wincode":
						return adapters.wincode.status(null);
					default:
						throw new Error("Unknown provider.");
				}
			}
			throw error;
		}
	};

	async function authorize(
		providerId: "anthropic",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["anthropic"]>;
	async function authorize(
		providerId: "google",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["google"]>;
	async function authorize(
		providerId: "openai",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["openai"]>;
	async function authorize(
		providerId: "wincode",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["wincode"]>;
	async function authorize(
		providerId: ConnectionProviderId
	): Promise<ConnectionAuthorization>;
	async function authorize(
		providerId: ConnectionProviderId,
		signal?: AbortSignal
	): Promise<ConnectionAuthorization> {
		const cached = authCache[providerId];
		if (cached !== undefined) {
			return signal ? await raceAbort(cached, signal) : cached;
		}
		const pending = runQueued<ConnectionAuthorization>(providerId, async () =>
			authorizers[providerId]()
		);
		authCache[providerId] = pending;
		const clearPending = () => {
			if (authCache[providerId] === pending) {
				delete authCache[providerId];
			}
		};
		pending.then(clearPending, clearPending);
		return signal ? await raceAbort(pending, signal) : pending;
	}

	const raceAbort = async <T>(
		promise: Promise<T>,
		signal: AbortSignal
	): Promise<T> => {
		if (signal.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
					},
					{ once: true }
				);
			}),
		]);
	};

	const connect = async (request: ConnectRequest): Promise<void> => {
		delete authCache[request.providerId];
		if (request.method === "browser") {
			request.onProgress?.("starting");
		}
		await runQueued(request.providerId, async () => {
			switch (request.providerId) {
				case "anthropic": {
					const anthropicCredential = await adapters.anthropic.connect(request);
					request.signal?.throwIfAborted();
					await vault.replaceValidated("anthropic", anthropicCredential);
					break;
				}
				case "google": {
					const googleCredential = await adapters.google.connect(request);
					request.signal?.throwIfAborted();
					await vault.replaceValidated("google", googleCredential);
					break;
				}
				case "openai": {
					const openaiCredential = await adapters.openai.connect(request);
					request.signal?.throwIfAborted();
					await vault.replaceValidated("openai", openaiCredential);
					break;
				}
				case "wincode": {
					const wincodeCredential = await adapters.wincode.connect(request);
					request.signal?.throwIfAborted();
					await vault.replaceValidated("wincode", wincodeCredential);
					break;
				}
				default:
					throw new Error("Unknown provider.");
			}
			if (request.method === "browser") {
				request.onProgress?.("connected");
			}
		});
	};

	return { listProviders, connect, authorize };
};
