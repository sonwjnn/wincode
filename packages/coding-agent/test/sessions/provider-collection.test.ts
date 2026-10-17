import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type {
	ChatEvent,
	ChatRequest,
	GoogleProviderOptions,
	ModelStore,
	Provider,
	ProviderCollection,
	ProviderModel,
} from "@wincode/ai";
import type {
	PluginProviderDescriptor,
	PluginRuntime,
} from "@/modules/plugins/runtime";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import { pluginProviderStorageId } from "@/modules/providers/provider-stores";
import { createDefaultSessionProviderCollection } from "@/modules/sessions/provider-collection";
import { createInMemoryCredentialStore } from "../support/provider-stores";

test("Host Google caches stay isolated over shared user-scoped Provider stores", async () => {
	const credentials = new Map<string, unknown>();
	const modelSnapshots = new Map<string, readonly ProviderModel[]>();
	const modelStoreReads: string[] = [];
	const credentialStore = createInMemoryCredentialStore(credentials);
	const modelStore: ModelStore = {
		get: (providerId) => {
			modelStoreReads.push(providerId);
			return modelSnapshots.get(providerId);
		},
		set: (providerId, models) => {
			modelSnapshots.set(providerId, models);
		},
	};
	const cacheCalls = {
		"first-host": { created: [] as string[], deleted: [] as string[] },
		"second-host": { created: [] as string[], deleted: [] as string[] },
	};
	const requestBodies: Record<
		keyof typeof cacheCalls,
		Record<string, unknown>[]
	> = {
		"first-host": [],
		"second-host": [],
	};
	const googleOptionsForHost = (
		host: keyof typeof cacheCalls
	): GoogleProviderOptions => ({
		createCacheClient: () => ({
			create: async () => {
				const name = `cachedContents/${host}`;
				cacheCalls[host].created.push(name);
				return { name };
			},
			delete: async ({ name }) => {
				cacheCalls[host].deleted.push(name);
				return {};
			},
		}),
		fetch: async (_input, init) => {
			requestBodies[host].push(
				JSON.parse(String(init?.body)) as Record<string, unknown>
			);
			return new Response(
				`data: {"candidates":[{"finishReason":"STOP"}]}${String.fromCharCode(10, 10)}`,
				{ headers: { "content-type": "text/event-stream" } }
			);
		},
	});
	const [first, second] = await Promise.all([
		createDefaultSessionProviderCollection(undefined, "first-host", {
			credentialStore,
			googleProviderOptions: googleOptionsForHost("first-host"),
			modelStore,
		}),
		createDefaultSessionProviderCollection(undefined, "second-host", {
			credentialStore,
			googleProviderOptions: googleOptionsForHost("second-host"),
			modelStore,
		}),
	]);
	const request: ChatRequest = {
		cacheRetention: "short",
		messages: [
			{ content: [{ text: "current prompt", type: "text" }], role: "user" },
		],
		modelId: "gemini-3.8-flash",
		providerId: "google",
		system: "Stable Host prefix",
	};
	const send = async (collection: ProviderCollection): Promise<void> => {
		const events: ChatEvent[] = [];
		for await (const event of collection.chat(request)) {
			events.push(event);
		}
		expect(
			events.some(
				(event) =>
					event.type === "terminal" && event.outcome.status === "success"
			)
		).toBe(true);
	};

	try {
		await Promise.all([first.restoreModels(), second.restoreModels()]);
		await first.setCredential("google", {
			apiKey: "shared-fake-google-key",
			kind: "api-key",
		});
		await Promise.all([send(first), send(second)]);
		await Promise.all([send(first), send(second)]);

		expect(credentials.get("google")).toEqual({
			apiKey: "shared-fake-google-key",
			kind: "api-key",
		});
		expect(
			modelStoreReads.filter((providerId) => providerId === "google")
		).toHaveLength(2);
		expect(cacheCalls["first-host"].created).toEqual([
			"cachedContents/first-host",
		]);
		expect(cacheCalls["second-host"].created).toEqual([
			"cachedContents/second-host",
		]);
		expect(
			requestBodies["first-host"].map(({ cachedContent }) => cachedContent)
		).toEqual(["cachedContents/first-host", "cachedContents/first-host"]);
		expect(
			requestBodies["second-host"].map(({ cachedContent }) => cachedContent)
		).toEqual(["cachedContents/second-host", "cachedContents/second-host"]);

		await first.close();
		expect(cacheCalls["first-host"].deleted).toEqual([
			"cachedContents/first-host",
		]);
		expect(cacheCalls["second-host"].deleted).toEqual([]);
		await send(second);
		expect(cacheCalls["second-host"].created).toEqual([
			"cachedContents/second-host",
		]);
		expect(cacheCalls["second-host"].deleted).toEqual([]);
	} finally {
		await Promise.all([first.close(), second.close()]);
	}

	expect(cacheCalls["first-host"].deleted).toEqual([
		"cachedContents/first-host",
	]);
	expect(cacheCalls["second-host"].deleted).toEqual([
		"cachedContents/second-host",
	]);
});

test("delegated Plugin Provider access requires the selected Plugin source identity", async () => {
	const providerId = "same-plugin-provider-id";
	const pluginModel: ProviderModel = {
		capabilities: ["text"],
		modelId: "selected-provider-model",
		providerId,
		protocolId: "fake-plugin-source",
	};
	const otherPluginModel: ProviderModel = {
		...pluginModel,
		modelId: "unselected-provider-model",
	};
	const selectedSource = {
		pluginId: "selected-provider-owner",
		providerId,
		sourceIdentity: "/trusted/selected-provider.ts",
		sourcePath: "/trusted/selected-provider.ts",
	};
	const otherSource = {
		pluginId: "unselected-provider-owner",
		providerId,
		sourceIdentity: "/trusted/unselected-provider.ts",
		sourcePath: "/trusted/unselected-provider.ts",
	};
	const registrations: PluginProviderDescriptor[] = [
		{
			...selectedSource,
			connect: async () => undefined,
			createProvider: () => ({
				id: providerId,
				models: [pluginModel],
				resolveAuthorization: ({ credential }) =>
					credential === undefined ? null : { authorization: credential },
				async *streamChat() {
					yield { type: "finish" };
				},
			}),
			displayName: "Selected Provider",
		},
		{
			...otherSource,
			connect: async () => undefined,
			createProvider: () => ({
				id: providerId,
				models: [otherPluginModel],
				resolveAuthorization: ({ credential }) =>
					credential === undefined ? null : { authorization: credential },
				async *streamChat() {
					yield { type: "finish" };
				},
			}),
			displayName: "Unselected Provider",
		},
	];
	const pluginRuntime = fromPartial<PluginRuntime>({
		getProviderRegistrations: () => registrations,
	});
	const selectedCredentialId = pluginProviderStorageId(selectedSource);
	const unselectedCredentialId = pluginProviderStorageId(otherSource);
	const credentialReads: string[] = [];
	const providerCollection = await createDefaultSessionProviderCollection(
		pluginRuntime,
		"delegated-child-session",
		{
			allowedPluginProviderIds: [providerId],
			allowedPluginProviderSources: [selectedSource],
			credentialStore: {
				delete: () => undefined,
				get: (storedProviderId) => {
					credentialReads.push(storedProviderId);
					if (storedProviderId === selectedCredentialId) {
						return "fake-selected-plugin-credential";
					}
					if (storedProviderId === unselectedCredentialId) {
						return "fake-unselected-plugin-credential";
					}
					return;
				},
				set: () => undefined,
			},
			modelStore: {
				get: () => undefined,
				set: () => undefined,
			},
		}
	);
	try {
		expect(
			providerCollection.getModel(providerId, pluginModel.modelId)
		).toEqual(pluginModel);
		expect(
			providerCollection.getModel(providerId, otherPluginModel.modelId)
		).toBeUndefined();
		await providerCollection.getAvailable();
		expect(credentialReads).toContain(selectedCredentialId);
		expect(credentialReads).not.toContain(unselectedCredentialId);
	} finally {
		await providerCollection.close();
	}
});

test("each Host gets fresh built-in and trusted Plugin Providers over shared app stores", async () => {
	const credentials = new Map<string, unknown>();
	const snapshots = new Map<string, readonly ProviderModel[]>();
	const credentialStore = createInMemoryCredentialStore(credentials);
	const modelStore: ModelStore = {
		get: (providerId) => snapshots.get(providerId),
		set: (providerId, models) => {
			snapshots.set(providerId, models);
		},
	};
	const pluginModel: ProviderModel = {
		modelId: "fixture-model",
		protocolId: "fixture-protocol",
		providerId: "trusted-fixture-provider",
	};
	const pluginInstances: Provider[] = [];
	let pluginCloseCalls = 0;
	const pluginRegistration: PluginProviderDescriptor = {
		connect: async () => undefined,
		createProvider: () => {
			const provider: Provider = {
				id: pluginModel.providerId,
				models: [pluginModel],
				resolveAuthorization: () => ({ authorization: {} }),
				async *streamChat() {
					yield { type: "finish" };
				},
				close: () => {
					pluginCloseCalls += 1;
				},
			};
			pluginInstances.push(provider);
			return provider;
		},
		displayName: "Trusted Fixture",
		pluginId: "trusted-fixture-plugin",
		providerId: pluginModel.providerId,
		sourceIdentity: "trusted-fixture-source",
		sourcePath: "trusted-fixture-source",
	};
	const runtimeSessionIds: (string | undefined)[] = [];
	const pluginRuntime = fromPartial<PluginRuntime>({
		getProviderRegistrations: (sessionId?: string) => {
			runtimeSessionIds.push(sessionId);
			return [pluginRegistration];
		},
	});
	const first = await createDefaultSessionProviderCollection(
		pluginRuntime,
		"first-host",
		{ credentialStore, modelStore }
	);
	const second = await createDefaultSessionProviderCollection(
		pluginRuntime,
		"second-host",
		{ credentialStore, modelStore }
	);

	try {
		const builtinProviderIds = new Set([
			...first.getModels().map(({ providerId }) => providerId),
			...first.getDiscoverableProviderIds(),
		]);
		for (const providerId of [
			"openai",
			"anthropic",
			"google",
			"opencode-go",
			"deepseek",
			"openrouter",
		]) {
			expect(builtinProviderIds.has(providerId)).toBe(true);
		}
		expect(builtinProviderIds.has("trusted-fixture-provider")).toBe(true);
		expect(runtimeSessionIds).toEqual(["first-host", "second-host"]);
		expect(pluginInstances).toHaveLength(2);
		expect(pluginInstances[0]).not.toBe(pluginInstances[1]);

		const firstController: InteractiveProviderController =
			createInteractiveProviderController(first);
		const secondController = createInteractiveProviderController(second);
		await first.setCredential("openai", {
			apiKey: "fake-openai-key",
			kind: "api-key",
		});
		expect(
			(await secondController.getAvailableModels()).some(
				({ providerId }) => providerId === "openai"
			)
		).toBe(true);
		expect(await firstController.getKnownModels()).toEqual(first.getModels());
	} finally {
		await Promise.all([first.close(), second.close()]);
	}

	expect(pluginCloseCalls).toBe(2);
	expect(credentials.get("openai")).toEqual({
		apiKey: "fake-openai-key",
		kind: "api-key",
	});
});
