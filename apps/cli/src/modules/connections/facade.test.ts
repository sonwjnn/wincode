import { describe, expect, mock, test } from "bun:test";
import type {
	ConnectionProviderSummary,
	CredentialByProvider,
	ProviderAdapterMap,
	ProviderMethod,
} from "./contract";
import { type ConnectionsVault, createConnections } from "./facade";
import { InvalidStoredConnectionError } from "./v2-credential-vault";

type AdapterOverrideMap = {
	[P in keyof ProviderAdapterMap]?: Partial<ProviderAdapterMap[P]>;
};

const credential = {
	accessToken: "old",
	accountId: "acct",
	expiresAt: new Date(Date.now() - 10_000).toISOString(),
	kind: "oauth-session" as const,
	refreshToken: "r",
	updatedAt: new Date().toISOString(),
};

const baseSummary = (
	id: "anthropic" | "google" | "openai" | "wincode",
	displayName: string,
	methods: readonly ProviderMethod[]
): ConnectionProviderSummary => ({
	connected: false,
	displayName,
	id,
	methods,
});

const createTestAdapters = (
	overrides: AdapterOverrideMap = {}
): ProviderAdapterMap => ({
	anthropic: {
		authorize: async () => ({
			authorization: { kind: "api-key", apiKey: "x" },
		}),
		connect: async () => ({ apiKey: "x", kind: "api-key" }),
		methods: ["api-key"],
		status: () => baseSummary("anthropic", "Anthropic", ["api-key"]),
		...overrides.anthropic,
	},
	google: {
		authorize: async () => ({
			authorization: { kind: "api-key", apiKey: "x" },
		}),
		connect: async () => ({ apiKey: "x", kind: "api-key" }),
		methods: ["api-key"],
		status: () => baseSummary("google", "Google", ["api-key"]),
		...overrides.google,
	},
	openai: {
		authorize: async () => ({
			authorization: { kind: "api-key", apiKey: "x" },
		}),
		connect: async () => ({ apiKey: "x", kind: "api-key" }),
		methods: ["api-key", "browser"],
		status: () => baseSummary("openai", "OpenAI", ["api-key", "browser"]),
		...overrides.openai,
	},
	wincode: {
		authorize: async () => ({
			authorization: { kind: "api-key", apiKey: "x" },
		}),
		connect: async () => ({ apiKey: "x", kind: "api-key" }),
		methods: ["api-key", "browser"],
		status: () => baseSummary("wincode", "Wincode", ["api-key", "browser"]),
		...overrides.wincode,
	},
});

const createMemoryVault = (
	initial: Partial<{
		anthropic: CredentialByProvider["anthropic"] | null;
		google: CredentialByProvider["google"] | null;
		openai: CredentialByProvider["openai"] | null;
		wincode: CredentialByProvider["wincode"] | null;
	}> = {}
): ConnectionsVault => {
	const state: {
		anthropic: CredentialByProvider["anthropic"] | null;
		google: CredentialByProvider["google"] | null;
		openai: CredentialByProvider["openai"] | null;
		wincode: CredentialByProvider["wincode"] | null;
	} = {
		anthropic: initial.anthropic ?? null,
		google: initial.google ?? null,
		openai: initial.openai ?? null,
		wincode: initial.wincode ?? null,
	};

	async function load(
		providerId: "anthropic"
	): Promise<CredentialByProvider["anthropic"] | null>;
	async function load(
		providerId: "google"
	): Promise<CredentialByProvider["google"] | null>;
	async function load(
		providerId: "openai"
	): Promise<CredentialByProvider["openai"] | null>;
	async function load(
		providerId: "wincode"
	): Promise<CredentialByProvider["wincode"] | null>;
	async function load(providerId: keyof ProviderAdapterMap) {
		switch (providerId) {
			case "anthropic":
				return state.anthropic;
			case "google":
				return state.google;
			case "openai":
				return state.openai;
			case "wincode":
				return state.wincode;
			default:
				throw new Error("Unknown provider.");
		}
	}

	async function replaceValidated(
		providerId: "anthropic",
		next: CredentialByProvider["anthropic"]
	): Promise<void>;
	async function replaceValidated(
		providerId: "google",
		next: CredentialByProvider["google"]
	): Promise<void>;
	async function replaceValidated(
		providerId: "openai",
		next: CredentialByProvider["openai"]
	): Promise<void>;
	async function replaceValidated(
		providerId: "wincode",
		next: CredentialByProvider["wincode"]
	): Promise<void>;
	async function replaceValidated(
		providerId: keyof ProviderAdapterMap,
		next: any
	) {
		switch (providerId) {
			case "anthropic":
				state.anthropic = next;
				return;
			case "google":
				state.google = next;
				return;
			case "openai":
				state.openai = next;
				return;
			case "wincode":
				state.wincode = next;
				return;
			default:
				throw new Error("Unknown provider.");
		}
	}

	return { load, replaceValidated };
};

const tick = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("createConnections", () => {
	test("connect invalidates auth cache before enqueue", async () => {
		const replaceValidated = mock(async () => undefined);
		const authorize = mock(async () => ({
			authorization: { kind: "api-key" as const, apiKey: "x" },
		}));
		const connections = createConnections({
			adapters: createTestAdapters({
				openai: { authorize },
			}),
			vault: { ...createMemoryVault({ openai: credential }), replaceValidated },
		});

		await connections.connect({
			apiKey: "x",
			method: "api-key",
			providerId: "openai",
		});

		expect(replaceValidated).toHaveBeenCalledTimes(1);
		expect(authorize).not.toHaveBeenCalled();
	});

	test("authorize singleflights and replacement commits before return", async () => {
		const next = { ...credential, accessToken: "new" };
		const replaceValidated = mock(async () => undefined);
		const authorize = mock(async () => ({
			authorization: {
				kind: "oauth" as const,
				accessToken: next.accessToken,
				accountId: next.accountId,
			},
			replacementCredential: next,
		}));
		const connections = createConnections({
			adapters: createTestAdapters({ openai: { authorize } }),
			vault: { ...createMemoryVault({ openai: credential }), replaceValidated },
		});

		await expect(connections.authorize("openai")).resolves.toEqual({
			kind: "oauth",
			accessToken: "new",
			accountId: "acct",
		});
		expect(replaceValidated).toHaveBeenCalledWith("openai", next);
	});

	test("browser connect emits starting before adapter and connected after commit", async () => {
		const events: string[] = [];
		const connections = createConnections({
			adapters: createTestAdapters({
				openai: {
					connect: async () => {
						events.push("adapter");
						return { apiKey: "x", kind: "api-key" };
					},
				},
			}),
			vault: createMemoryVault({
				openai: credential,
				google: { apiKey: "google", kind: "api-key" },
			}),
		});

		await connections.connect({
			method: "browser",
			onProgress: (status) => events.push(status),
			providerId: "openai",
			signal: new AbortController().signal,
		});

		expect(events).toEqual(["starting", "adapter", "connected"]);
	});

	test("browser connect does not emit connected on failure", async () => {
		const events: string[] = [];
		const connections = createConnections({
			adapters: createTestAdapters({
				openai: {
					connect: async () => {
						throw new Error("boom");
					},
				},
			}),
			vault: createMemoryVault({ openai: credential }),
		});

		await expect(
			connections.connect({
				method: "browser",
				onProgress: (status) => events.push(status),
				providerId: "openai",
				signal: new AbortController().signal,
			})
		).rejects.toThrow("boom");
		expect(events).toEqual(["starting"]);
	});

	test("listProviders returns ids and no secrets", async () => {
		const connections = createConnections({
			adapters: createTestAdapters(),
			vault: createMemoryVault(),
		});

		await expect(connections.listProviders()).resolves.toHaveLength(4);
	});

	test("listProviders treats corrupt record as disconnected and propagates operational errors", async () => {
		const adapters = createTestAdapters();
		const connections = createConnections({
			adapters,
			vault: {
				load: async (providerId) => {
					switch (providerId) {
						case "anthropic":
							return null;
						case "google":
							throw new Error("disk offline");
						case "openai":
							throw new InvalidStoredConnectionError("openai");
						case "wincode":
							return null;
						default:
							throw new Error("Unknown provider.");
					}
				},
				replaceValidated: async () => undefined,
			},
		});

		await expect(connections.listProviders()).rejects.toThrow("disk offline");
		await expect(
			createConnections({
				adapters,
				vault: {
					load: async (providerId) => {
						if (providerId === "openai") {
							throw new InvalidStoredConnectionError("openai");
						}
						return null;
					},
					replaceValidated: async () => undefined,
				},
			}).listProviders()
		).resolves.toEqual([
			adapters.anthropic.status(null),
			adapters.google.status(null),
			adapters.openai.status(null),
			adapters.wincode.status(null),
		]);
	});

	test("authorize singleflights concurrent calls", async () => {
		let calls = 0;
		let release!: () => void;
		const authorize = mock(async () => {
			calls += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { authorization: { kind: "api-key" as const, apiKey: "x" } };
		});
		const connections = createConnections({
			adapters: createTestAdapters({ openai: { authorize } }),
			vault: createMemoryVault({ openai: credential }),
		});

		const first = connections.authorize("openai");
		const second = connections.authorize("openai");
		await tick();
		expect(calls).toBe(1);
		release();
		await expect(first).resolves.toEqual({ kind: "api-key", apiKey: "x" });
		await expect(second).resolves.toEqual({ kind: "api-key", apiKey: "x" });
	});

	test("authorize waits for deferred replacement persistence", async () => {
		let release!: () => void;
		const replacement = { ...credential, accessToken: "replacement" };
		const replaceValidated = mock(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const connections = createConnections({
			adapters: createTestAdapters({
				openai: {
					authorize: async () => ({
						authorization: { kind: "api-key" as const, apiKey: "x" },
						replacementCredential: replacement,
					}),
				},
			}),
			vault: { ...createMemoryVault({ openai: credential }), replaceValidated },
		});
		const result = connections.authorize("openai");
		await tick();
		expect(replaceValidated).toHaveBeenCalled();
		let settled = false;
		result.then(() => {
			settled = true;
		});
		await tick();
		expect(settled).toBe(false);
		release();
		await expect(result).resolves.toEqual({ kind: "api-key", apiKey: "x" });
	});

	test("blocked openai authorization does not block google", async () => {
		const connections = createConnections({
			adapters: createTestAdapters({
				openai: { authorize: async () => await new Promise(() => undefined) },
				google: {
					authorize: async () => ({
						authorization: { kind: "api-key" as const, apiKey: "google" },
					}),
				},
			}),
			vault: createMemoryVault({
				openai: credential,
				google: { apiKey: "google", kind: "api-key" },
			}),
		});
		connections.authorize("openai");
		await expect(connections.authorize("google")).resolves.toEqual({
			kind: "api-key",
			apiKey: "google",
		});
	});

	test("sequential authorizations call adapter twice", async () => {
		const authorize = mock(async () => ({
			authorization: { kind: "api-key" as const, apiKey: "x" },
		}));
		const connections = createConnections({
			adapters: createTestAdapters({ openai: { authorize } }),
			vault: createMemoryVault({ openai: credential }),
		});
		await connections.authorize("openai");
		await connections.authorize("openai");
		expect(authorize).toHaveBeenCalledTimes(2);
	});

	test("authorize after blocked connect sees new credential", async () => {
		let releaseConnect!: () => void;
		const nextCredential = {
			...credential,
			accessToken: "next",
			updatedAt: new Date().toISOString(),
		};
		const vault = createMemoryVault({ openai: credential });
		const authorize = mock(async (stored) => ({
			authorization: {
				kind: "oauth" as const,
				accessToken: stored.accessToken,
				accountId: stored.accountId ?? "acct",
			},
		}));
		const connections = createConnections({
			adapters: createTestAdapters({
				openai: {
					authorize,
					connect: mock(async () => {
						await new Promise<void>((resolve) => {
							releaseConnect = resolve;
						});
						return nextCredential;
					}),
				},
			}),
			vault,
		});

		const connectPromise = connections.connect({
			method: "browser",
			onProgress: () => undefined,
			providerId: "openai",
			signal: new AbortController().signal,
		});
		await tick();
		let authorizeSettled = false;
		const authorizePromise = connections.authorize("openai");
		authorizePromise.then(() => {
			authorizeSettled = true;
		});
		await tick();
		expect(authorizeSettled).toBe(false);
		expect(authorize).not.toHaveBeenCalled();
		releaseConnect();
		await connectPromise;
		await expect(authorizePromise).resolves.toEqual({
			kind: "oauth",
			accessToken: "next",
			accountId: "acct",
		});
	});

	test("failed authorize releases queue and cache", async () => {
		let attempts = 0;
		const authorize = mock(async () => {
			attempts += 1;
			throw new Error("boom");
		});
		const connections = createConnections({
			adapters: createTestAdapters({ openai: { authorize } }),
			vault: createMemoryVault({ openai: credential }),
		});

		await expect(connections.authorize("openai")).rejects.toThrow("boom");
		await expect(connections.authorize("openai")).rejects.toThrow("boom");
		expect(attempts).toBe(2);
	});

	test("authorize abort only cancels caller wait", async () => {
		let release!: () => void;
		let calls = 0;
		const authorize = mock(async () => {
			calls += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { authorization: { kind: "api-key" as const, apiKey: "x" } };
		});
		const connections = createConnections({
			adapters: createTestAdapters({ openai: { authorize } }),
			vault: createMemoryVault({ openai: credential }),
		});

		const controller = new AbortController();
		const first = connections.authorize("openai", controller.signal);
		const second = connections.authorize("openai");
		await tick();
		controller.abort();
		await expect(first).rejects.toThrow("The operation was aborted.");
		release();
		await expect(second).resolves.toEqual({ kind: "api-key", apiKey: "x" });
		expect(calls).toBe(1);
		expect(authorize).toHaveBeenCalledWith(credential, undefined);
	});

	test("browser connect aborts before commit after acquisition", async () => {
		const replaceValidated = mock(async () => undefined);
		const controller = new AbortController();
		let releaseAcquire!: () => void;
		const connections = createConnections({
			adapters: createTestAdapters({
				openai: {
					connect: async () => {
						await new Promise<void>((resolve) => {
							releaseAcquire = resolve;
						});
						await tick();
						return { apiKey: "x", kind: "api-key" };
					},
				},
			}),
			vault: { ...createMemoryVault(), replaceValidated },
		});

		const promise = connections.connect({
			method: "browser",
			onProgress: () => undefined,
			providerId: "openai",
			signal: controller.signal,
		});
		await tick();
		controller.abort();
		releaseAcquire();
		await expect(promise).rejects.toThrow();
		expect(replaceValidated).not.toHaveBeenCalled();
	});
});
