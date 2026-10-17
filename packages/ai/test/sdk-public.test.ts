import { describe, expect, test } from "bun:test";
import {
	type ChatEvent,
	type ChatMessage,
	createProviderCollection,
	type Provider,
	type ProviderChatEvent,
	ProviderError,
	type ProviderModel,
	parseProviderModelSelection,
	providerModelSelectionSchema,
} from "@wincode/ai";

const demoProvider = (): Provider => ({
	id: "demo-provider",
	models: [
		{
			modelId: "demo-model",
			protocolId: "demo-protocol",
			providerId: "demo-provider",
		},
	],
	resolveAuthorization: async ({ credential }) =>
		credential === undefined ? null : { authorization: credential },
	async *streamChat(_request, _context): AsyncIterable<ProviderChatEvent> {
		yield { delta: "Hello", type: "text-delta" };
		yield { delta: "reason", type: "reasoning-delta" };
		yield {
			input: { city: "Paris" },
			toolCallId: "call-1",
			toolName: "weather",
			type: "tool-call",
		};
		yield {
			type: "usage",
			usage: { inputTokens: 4, outputTokens: 2 },
		};
	},
});

test("SDK selection parsing preserves exact unknown Provider Model identity", () => {
	const selection = parseProviderModelSelection(
		"plugin-provider/vendor/model-v4"
	);
	expect(selection).toEqual({
		modelId: "vendor/model-v4",
		providerId: "plugin-provider",
	});
	expect(providerModelSelectionSchema.safeParse(selection).success).toBe(true);
	expect(parseProviderModelSelection("plugin-provider/")).toBeNull();
	expect(
		providerModelSelectionSchema.safeParse({
			modelId: "",
			providerId: "plugin-provider",
		}).success
	).toBe(false);
});

describe("public SDK provider collection", () => {
	test("external consumers can register a custom provider and stream normalized events", async () => {
		const sdk = createProviderCollection();
		sdk.register(demoProvider());
		await sdk.setCredential("demo-provider", { token: "app-owned-secret" });

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [{ content: [{ text: "Hello", type: "text" }], role: "user" }],
			modelId: "demo-model",
			providerId: "demo-provider",
		})) {
			events.push(event);
		}

		expect(sdk.getModels()).toEqual([
			{
				modelId: "demo-model",
				protocolId: "demo-protocol",
				providerId: "demo-provider",
			},
		]);
		expect(events).toEqual([
			{ delta: "Hello", type: "text-delta" },
			{ delta: "reason", type: "reasoning-delta" },
			{
				input: { city: "Paris" },
				toolCallId: "call-1",
				toolName: "weather",
				type: "tool-call",
			},
			{ type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
			{ type: "terminal", outcome: { status: "success" } },
		]);
	});

	test("ProviderCollection close awaits every Provider once even when cleanup fails", async () => {
		const cleanupStarted: string[] = [];
		const bothCleanupsStarted = Promise.withResolvers<void>();
		const finishSecondCleanup = Promise.withResolvers<void>();
		const recordCleanup = (providerId: string): void => {
			cleanupStarted.push(providerId);
			if (cleanupStarted.length === 2) {
				bothCleanupsStarted.resolve();
			}
		};
		const sdk = createProviderCollection();
		sdk.register({
			...demoProvider(),
			close: () => {
				recordCleanup("failed-provider");
				throw new Error("private cleanup detail");
			},
			id: "failed-provider",
			models: [
				{
					modelId: "failed-model",
					protocolId: "demo-protocol",
					providerId: "failed-provider",
				},
			],
		});
		sdk.register({
			...demoProvider(),
			close: async () => {
				recordCleanup("deferred-provider");
				await finishSecondCleanup.promise;
			},
			id: "deferred-provider",
			models: [
				{
					modelId: "deferred-model",
					protocolId: "demo-protocol",
					providerId: "deferred-provider",
				},
			],
		});

		const closing = sdk.close();
		let settled = false;
		void closing.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			}
		);
		expect(sdk.close()).toBe(closing);
		await bothCleanupsStarted.promise;
		expect(cleanupStarted).toEqual(["failed-provider", "deferred-provider"]);
		expect(settled).toBe(false);
		finishSecondCleanup.resolve();
		await expect(closing).rejects.toThrow(
			"One or more Providers failed to close."
		);
		expect(sdk.close()).toBe(closing);
		expect(cleanupStarted).toEqual(["failed-provider", "deferred-provider"]);
		expect(() => sdk.register(demoProvider())).toThrow(
			"ProviderCollection is closed."
		);
	});

	test("tool failures in history remain provider-neutral message parts", async () => {
		const sdk = createProviderCollection();
		const failedToolMessage: ChatMessage = {
			content: [
				{
					errorText: "Weather lookup failed.",
					failure: { kind: "timeout" },
					toolCallId: "call-1",
					toolName: "weather",
					type: "tool-failure",
				},
			],
			role: "tool",
		};
		const receivedMessages: (readonly ChatMessage[])[] = [];
		sdk.register({
			...demoProvider(),
			id: "tool-failure-provider",
			models: [
				{
					modelId: "tool-failure-model",
					protocolId: "tool-failure-wire",
					providerId: "tool-failure-provider",
				},
			],
			async *streamChat(request) {
				receivedMessages.push(request.messages);
				expect(request.cacheRetention).toBe("long");
				expect(request.cacheWarming).toBe(true);
				expect(request.maxOutputTokens).toBe(384);
				expect(request.promptCacheKey).toBe("stable-session-cache-key");
				expect(request.reasoningEffort).toBe("high");
				yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
				yield { type: "finish", continuation: { cursor: "next" } };
			},
		});
		await sdk.setCredential("tool-failure-provider", "configured");

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "long",
			cacheWarming: true,
			maxOutputTokens: 384,
			messages: [failedToolMessage],
			modelId: "tool-failure-model",
			promptCacheKey: "stable-session-cache-key",
			providerId: "tool-failure-provider",
			reasoningEffort: "high",
		})) {
			events.push(event);
		}

		expect(receivedMessages).toEqual([[failedToolMessage]]);
		expect(events).toEqual([
			{ type: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
			{
				outcome: { continuation: { cursor: "next" }, status: "success" },
				type: "terminal",
			},
		]);
	});

	test("missing provider and model selections terminate without substituting another model", async () => {
		const sdk = createProviderCollection();
		sdk.register(demoProvider());

		const collect = async (providerId: string, modelId: string) => {
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [],
				modelId,
				providerId,
			})) {
				events.push(event);
			}
			return events;
		};

		expect(await collect("missing-provider", "demo-model")).toEqual([
			{
				outcome: {
					failure: {
						code: "provider-not-found",
						providerId: "missing-provider",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
		expect(await collect("demo-provider", "missing-model")).toEqual([
			{
				outcome: {
					failure: {
						code: "model-not-found",
						modelId: "missing-model",
						providerId: "demo-provider",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
	});

	test("provider failures and aborts terminate partial streams without a success outcome", async () => {
		const sdk = createProviderCollection();
		const provider: Provider = {
			...demoProvider(),
			id: "failing-provider",
			models: [
				{
					modelId: "failing-model",
					protocolId: "custom-wire",
					providerId: "failing-provider",
				},
			],
			resolveAuthorization: async () => ({ authorization: "ok" }),
			async *streamChat() {
				yield { delta: "partial", type: "text-delta" };
				throw new ProviderError("transport", "connection dropped");
			},
		};
		sdk.register(provider);

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "failing-model",
			providerId: "failing-provider",
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{ delta: "partial", type: "text-delta" },
			{
				outcome: {
					failure: {
						code: "transport",
						message: "connection dropped",
						providerId: "failing-provider",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
	});

	test("aborting after partial output produces an abort terminal instead of success", async () => {
		const sdk = createProviderCollection();
		sdk.register({
			...demoProvider(),
			id: "abort-provider",
			models: [
				{
					modelId: "abort-model",
					protocolId: "abort-wire",
					providerId: "abort-provider",
				},
			],
			async *streamChat() {
				yield { delta: "partial", type: "text-delta" };
				throw new DOMException("stream cancelled", "AbortError");
			},
		});
		await sdk.setCredential("abort-provider", "configured");

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "abort-model",
			providerId: "abort-provider",
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{ delta: "partial", type: "text-delta" },
			{
				outcome: { reason: "stream cancelled", status: "aborted" },
				type: "terminal",
			},
		]);
	});

	test("multimodal input reaches custom providers and explicit capability gaps are reported", async () => {
		const requests: unknown[] = [];
		const sdk = createProviderCollection();
		const provider: Provider = {
			id: "media-provider",
			models: [
				{
					modelId: "media-model",
					protocolId: "custom-media-wire",
					providerId: "media-provider",
				},
				{
					capabilities: ["text"],
					modelId: "text-only",
					protocolId: "custom-media-wire",
					providerId: "media-provider",
				},
			],
			resolveAuthorization: async () => ({ authorization: "ok" }),
			async *streamChat(request) {
				requests.push(request.messages);
				yield { delta: "received", type: "text-delta" };
			},
		};
		sdk.register(provider);

		const multimodalMessages: readonly ChatMessage[] = [
			{
				content: [
					{ text: "Describe this", type: "text" },
					{ data: "aW1hZ2U=", mediaType: "image/png", type: "image" },
					{ data: "YXR0YWNobWVudA==", mediaType: "text/plain", type: "file" },
				],
				role: "user",
			},
		];
		const supportedEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: multimodalMessages,
			modelId: "media-model",
			providerId: "media-provider",
		})) {
			supportedEvents.push(event);
		}
		const unsupportedEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: multimodalMessages,
			modelId: "text-only",
			providerId: "media-provider",
		})) {
			unsupportedEvents.push(event);
		}

		expect(requests).toEqual([multimodalMessages]);
		expect(supportedEvents.at(-1)).toEqual({
			outcome: { status: "success" },
			type: "terminal",
		});
		expect(unsupportedEvents).toEqual([
			{
				outcome: {
					failure: {
						capability: "image",
						code: "unsupported-capability",
						modelId: "text-only",
						providerId: "media-provider",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
	});

	test("tool history fails capability checks without tools before provider dispatch", async () => {
		let providerDispatches = 0;
		const sdk = createProviderCollection();
		sdk.register({
			...demoProvider(),
			id: "text-only-provider",
			models: [
				{
					capabilities: ["text"],
					modelId: "text-only-model",
					protocolId: "text-only-wire",
					providerId: "text-only-provider",
				},
			],
			async *streamChat() {
				providerDispatches += 1;
				yield { delta: "unexpected dispatch", type: "text-delta" };
			},
		});

		await sdk.setCredential("text-only-provider", "configured");

		const toolHistory: readonly ChatMessage[] = [
			{
				content: [
					{
						input: { city: "Paris" },
						toolCallId: "call-1",
						toolName: "weather",
						type: "tool-call",
					},
				],
				role: "assistant",
			},
			{
				content: [
					{
						output: { temperature: 20 },
						toolCallId: "call-1",
						toolName: "weather",
						type: "tool-result",
					},
				],
				role: "tool",
			},
		];

		for (const message of toolHistory) {
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [message],
				modelId: "text-only-model",
				providerId: "text-only-provider",
			})) {
				events.push(event);
			}

			expect(events).toEqual([
				{
					outcome: {
						failure: {
							capability: "tools",
							code: "unsupported-capability",
							modelId: "text-only-model",
							providerId: "text-only-provider",
						},
						status: "failure",
					},
					type: "terminal",
				},
			]);
		}

		expect(providerDispatches).toBe(0);
	});

	test("app-owned credentials are refreshed serially and default credentials stay instance-local", async () => {
		let storedCredential: unknown = "initial";
		const observedCredentials: unknown[] = [];
		const storeWrites: unknown[] = [];
		const credentialStore = {
			delete: async () => {
				storedCredential = undefined;
			},
			get: async () => storedCredential,
			set: async (_providerId: string, credential: unknown) => {
				storedCredential = credential;
				storeWrites.push(credential);
			},
		};
		const makeProvider = (): Provider => ({
			id: "rotating-provider",
			models: [
				{
					modelId: "rotating-model",
					protocolId: "rotating-wire",
					providerId: "rotating-provider",
				},
			],
			resolveAuthorization: async ({ credential }) => {
				observedCredentials.push(credential);
				await Promise.resolve();
				if (credential === undefined) {
					return null;
				}
				if (credential === "initial") {
					return { authorization: "bearer:rotated", credential: "rotated" };
				}
				return { authorization: `bearer:${String(credential)}` };
			},
			async *streamChat(_request, context) {
				yield { delta: String(context.authorization), type: "text-delta" };
			},
		});
		const sdk = createProviderCollection({ credentialStore });
		sdk.register(makeProvider());
		await sdk.setCredential("rotating-provider", "initial");

		const collect = async () => {
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [],
				modelId: "rotating-model",
				providerId: "rotating-provider",
			})) {
				events.push(event);
			}
			return events;
		};
		await Promise.all([collect(), collect()]);

		expect(observedCredentials).toEqual(["initial", "rotated"]);
		expect(storeWrites).toEqual(["initial", "rotated"]);
		expect(storedCredential).toBe("rotated");

		const isolated = createProviderCollection();
		isolated.register(makeProvider());
		const isolatedEvents: ChatEvent[] = [];
		for await (const event of isolated.chat({
			messages: [],
			modelId: "rotating-model",
			providerId: "rotating-provider",
		})) {
			isolatedEvents.push(event);
		}
		expect(isolatedEvents).toEqual([
			{
				outcome: {
					failure: {
						code: "authentication",
						message: "Provider rotating-provider has no usable credentials.",
						providerId: "rotating-provider",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
	});

	test("providers sharing a protocol keep their models and credentials separate", async () => {
		const sdk = createProviderCollection();
		const makeProtocolProvider = (id: string): Provider => ({
			id,
			models: [{ modelId: "model", protocolId: "shared-wire", providerId: id }],
			resolveAuthorization: async ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat(_request, { authorization, model }) {
				yield {
					delta: `${model.providerId}:${String(authorization)}`,
					type: "text-delta",
				};
			},
		});
		const firstProvider = makeProtocolProvider("first-provider");
		sdk.register(firstProvider);
		sdk.register(makeProtocolProvider("second-provider"));
		expect(() => sdk.register(firstProvider)).toThrow(
			"Provider already registered: first-provider"
		);
		await sdk.setCredential("first-provider", "first-secret");
		await sdk.setCredential("second-provider", "second-secret");

		const streamText = async (providerId: string) => {
			const text: string[] = [];
			for await (const event of sdk.chat({
				messages: [],
				modelId: "model",
				providerId,
			})) {
				if (event.type === "text-delta") {
					text.push(event.delta);
				}
			}
			return text;
		};

		expect(await streamText("first-provider")).toEqual([
			"first-provider:first-secret",
		]);
		expect(await streamText("second-provider")).toEqual([
			"second-provider:second-secret",
		]);
		expect(sdk.getModels().map((model) => model.protocolId)).toEqual([
			"shared-wire",
			"shared-wire",
		]);
	});

	test("unsupported cache-retention preferences remain optional for custom providers", async () => {
		const sdk = createProviderCollection();
		sdk.register({
			...demoProvider(),
			id: "no-cache-provider",
			models: [
				{
					modelId: "no-cache-model",
					protocolId: "no-cache-wire",
					providerId: "no-cache-provider",
				},
			],
			async *streamChat(request) {
				expect(request.cacheRetention).toBe("long");
				yield { delta: "cache-independent", type: "text-delta" };
			},
		});
		await sdk.setCredential("no-cache-provider", "configured");

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "long",
			messages: [],
			modelId: "no-cache-model",
			providerId: "no-cache-provider",
		})) {
			events.push(event);
		}

		expect(events.at(-1)).toEqual({
			outcome: { status: "success" },
			type: "terminal",
		});
	});

	test("late offline restore does not replace a concurrent successful refresh", async () => {
		const staticModel = {
			modelId: "static-model",
			protocolId: "racing-wire",
			providerId: "racing-provider",
		};
		const staleModel = {
			modelId: "stale-model",
			protocolId: "racing-wire",
			providerId: "racing-provider",
		};
		const refreshedModel = {
			modelId: "refreshed-model",
			protocolId: "racing-wire",
			providerId: "racing-provider",
		};
		const readStarted = Promise.withResolvers<void>();
		const storedSnapshot = Promise.withResolvers<
			readonly ProviderModel[] | undefined
		>();
		let persistedModels: readonly ProviderModel[] = [staleModel];
		const modelStore = {
			get: (providerId: string) => {
				expect(providerId).toBe("racing-provider");
				readStarted.resolve();
				return storedSnapshot.promise;
			},
			set: async (providerId: string, models: readonly ProviderModel[]) => {
				expect(providerId).toBe("racing-provider");
				persistedModels = models;
			},
		};
		const credentials = new Map<string, unknown>([
			["racing-provider", "configured"],
		]);
		const credentialStore = {
			delete: async (providerId: string) => {
				credentials.delete(providerId);
			},
			get: async (providerId: string) => credentials.get(providerId),
			set: async (providerId: string, credential: unknown) => {
				credentials.set(providerId, credential);
			},
		};
		const provider: Provider = {
			id: "racing-provider",
			models: [staticModel],
			discoverModels: async () => [refreshedModel],
			resolveAuthorization: async () => ({ authorization: "token" }),
			async *streamChat() {
				yield { delta: "unused", type: "text-delta" };
			},
		};
		const sdk = createProviderCollection({ credentialStore, modelStore });
		sdk.register(provider);
		const restoring = sdk.restoreModels();
		await readStarted.promise;

		await sdk.refreshModels("racing-provider");
		expect(sdk.getModels()).toEqual([staticModel, refreshedModel]);
		storedSnapshot.resolve([staleModel]);
		await restoring;

		expect(sdk.getModels()).toEqual([staticModel, refreshedModel]);
		expect(sdk.getModel("racing-provider", "stale-model")).toBeUndefined();
		expect(persistedModels).toEqual([refreshedModel]);
	});

	test("aborting a pending model-store write preserves the last-known snapshot", async () => {
		const staticModel = {
			modelId: "static-model",
			protocolId: "atomic-write-wire",
			providerId: "atomic-write-provider",
		};
		const lastKnownModel = {
			modelId: "last-known-model",
			protocolId: "atomic-write-wire",
			providerId: "atomic-write-provider",
		};
		const discoveredModel = {
			modelId: "discovered-model",
			protocolId: "atomic-write-wire",
			providerId: "atomic-write-provider",
		};
		const persistedModels = new Map<string, readonly ProviderModel[]>([
			["atomic-write-provider", [lastKnownModel]],
		]);
		const writeStarted = Promise.withResolvers<void>();
		const modelStore = {
			get: async (providerId: string) => persistedModels.get(providerId),
			set: async (
				providerId: string,
				models: readonly ProviderModel[],
				options: Readonly<{ signal?: AbortSignal }>
			) => {
				writeStarted.resolve();
				const signal = options.signal;
				if (!signal) {
					throw new Error("ModelStore.set did not receive the refresh signal.");
				}
				const write = Promise.withResolvers<void>();
				const rejectBeforeCommit = () => {
					write.reject(
						signal.reason ?? new DOMException("Write aborted", "AbortError")
					);
				};
				if (signal.aborted) {
					rejectBeforeCommit();
				} else {
					signal.addEventListener("abort", rejectBeforeCommit, { once: true });
				}
				await write.promise;
				persistedModels.set(providerId, models);
			},
		};
		const credentials = new Map<string, unknown>();
		const credentialStore = {
			delete: async (providerId: string) => {
				credentials.delete(providerId);
			},
			get: async (providerId: string) => credentials.get(providerId),
			set: async (providerId: string, credential: unknown) => {
				credentials.set(providerId, credential);
			},
		};
		const provider: Provider = {
			id: "atomic-write-provider",
			models: [staticModel],
			discoverModels: async () => [discoveredModel],
			resolveAuthorization: async ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat() {
				yield { delta: "unused", type: "text-delta" };
			},
		};
		const sdk = createProviderCollection({ credentialStore, modelStore });
		sdk.register(provider);
		await sdk.restoreModels();
		await sdk.setCredential("atomic-write-provider", "configured");
		const controller = new AbortController();
		const refreshing = sdk.refreshModels("atomic-write-provider", {
			signal: controller.signal,
		});
		await writeStarted.promise;

		controller.abort(
			new DOMException("model-store write cancelled", "AbortError")
		);
		await expect(refreshing).rejects.toThrow("model-store write cancelled");
		expect(sdk.getModels()).toEqual([staticModel, lastKnownModel]);
		expect(persistedModels.get("atomic-write-provider")).toEqual([
			lastKnownModel,
		]);
	});

	test("consumers can discover, call, and restore provider models without network access", async () => {
		const staticModel = {
			modelId: "static-model",
			protocolId: "dynamic-wire",
			providerId: "dynamic-provider",
		};
		const discoveredModel = {
			modelId: "published-model",
			protocolId: "dynamic-wire",
			providerId: "dynamic-provider",
		};
		const storedModels = new Map<string, readonly (typeof discoveredModel)[]>();
		const storedCredentials = new Map<string, unknown>();
		const modelStore = {
			get: async (providerId: string) => storedModels.get(providerId),
			set: async (
				providerId: string,
				models: readonly (typeof discoveredModel)[]
			) => {
				storedModels.set(providerId, models);
			},
		};
		const credentialStore = {
			delete: async (providerId: string) => {
				storedCredentials.delete(providerId);
			},
			get: async (providerId: string) => storedCredentials.get(providerId),
			set: async (providerId: string, credential: unknown) => {
				storedCredentials.set(providerId, credential);
			},
		};
		let discoveries = 0;
		const provider = (): Provider => ({
			id: "dynamic-provider",
			models: [staticModel],
			discoverModels: async ({ authorization }) => {
				discoveries += 1;
				expect(authorization).toBe("configured-secret");
				return [discoveredModel];
			},
			resolveAuthorization: async ({ credential }) =>
				credential === undefined ? null : { authorization: credential },
			async *streamChat(_request, { model }) {
				yield { delta: model.modelId, type: "text-delta" };
			},
		});
		const sdk = createProviderCollection({ credentialStore, modelStore });
		sdk.register(provider());
		await sdk.restoreModels();
		await sdk.setCredential("dynamic-provider", "configured-secret");

		await sdk.refreshModels("dynamic-provider");
		expect(sdk.getModels()).toEqual([staticModel, discoveredModel]);
		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "published-model",
			providerId: "dynamic-provider",
		})) {
			events.push(event);
		}
		expect(events).toEqual([
			{ delta: "published-model", type: "text-delta" },
			{ outcome: { status: "success" }, type: "terminal" },
		]);

		const restored = createProviderCollection({ credentialStore, modelStore });
		restored.register(provider());
		await restored.restoreModels();
		expect(restored.getModels()).toEqual([staticModel, discoveredModel]);
		const restoredEvents: ChatEvent[] = [];
		for await (const event of restored.chat({
			messages: [],
			modelId: "published-model",
			providerId: "dynamic-provider",
		})) {
			restoredEvents.push(event);
		}
		expect(restoredEvents.at(-1)).toEqual({
			outcome: { status: "success" },
			type: "terminal",
		});
		expect(discoveries).toBe(1);
	});

	test("known models and credential-filtered availability do not perform health checks", async () => {
		const staticModel = {
			modelId: "shared-model",
			protocolId: "static-wire",
			providerId: "configured-provider",
		};
		const duplicateDiscoveredModel = {
			modelId: "shared-model",
			protocolId: "discovered-wire",
			providerId: "configured-provider",
		};
		const discoveredModel = {
			modelId: "cached-model",
			protocolId: "discovered-wire",
			providerId: "configured-provider",
		};
		const otherProviderModel = {
			modelId: "cached-model",
			protocolId: "other-wire",
			providerId: "unconfigured-provider",
		};
		const otherDiscoveredModel = {
			modelId: "other-discovered-model",
			protocolId: "other-wire",
			providerId: "unconfigured-provider",
		};
		const storedModels = new Map<string, readonly ProviderModel[]>([
			["configured-provider", [duplicateDiscoveredModel, discoveredModel]],
			["unconfigured-provider", [otherDiscoveredModel]],
		]);
		const modelStore = {
			get: async (providerId: string) => storedModels.get(providerId),
			set: async (providerId: string, models: readonly ProviderModel[]) => {
				storedModels.set(providerId, models);
			},
		};
		const credentials = new Map<string, unknown>([
			["configured-provider", "configured"],
		]);
		const credentialReads: string[] = [];
		const credentialStore = {
			delete: async (providerId: string) => {
				credentials.delete(providerId);
			},
			get: async (providerId: string) => {
				credentialReads.push(providerId);
				return credentials.get(providerId);
			},
			set: async (providerId: string, credential: unknown) => {
				credentials.set(providerId, credential);
			},
		};
		let authorizationChecks = 0;
		let discoveryCalls = 0;
		const makeProvider = (
			id: string,
			models: readonly (typeof staticModel)[]
		): Provider => ({
			id,
			models,
			discoverModels: async () => {
				discoveryCalls += 1;
				return [];
			},
			resolveAuthorization: async () => {
				authorizationChecks += 1;
				return { authorization: "unused" };
			},
			async *streamChat() {
				yield { delta: "unused", type: "text-delta" };
			},
		});
		const sdk = createProviderCollection({ credentialStore, modelStore });
		sdk.register(makeProvider("configured-provider", [staticModel]));
		sdk.register(makeProvider("unconfigured-provider", [otherProviderModel]));
		await sdk.restoreModels();

		expect(sdk.getModels()).toEqual([
			staticModel,
			discoveredModel,
			otherProviderModel,
			otherDiscoveredModel,
		]);
		expect(await sdk.getAvailable()).toEqual([staticModel, discoveredModel]);
		expect(credentialReads).toEqual([
			"configured-provider",
			"unconfigured-provider",
		]);
		credentialReads.length = 0;
		expect(await sdk.getAvailable("configured-provider")).toEqual([
			staticModel,
			discoveredModel,
		]);
		expect(credentialReads).toEqual(["configured-provider"]);
		credentialReads.length = 0;
		expect(await sdk.getAvailable("unconfigured-provider")).toEqual([]);
		expect(credentialReads).toEqual(["unconfigured-provider"]);
		credentialReads.length = 0;
		expect(await sdk.getAvailable("missing-provider")).toEqual([]);
		expect(credentialReads).toEqual([]);
		expect(authorizationChecks).toBe(0);
		expect(discoveryCalls).toBe(0);

		await sdk.refreshModels("configured-provider");
		expect(
			sdk.getModel("unconfigured-provider", "other-discovered-model")
		).toEqual(otherDiscoveredModel);
		expect(sdk.getModels()).toEqual([
			staticModel,
			otherProviderModel,
			otherDiscoveredModel,
		]);
	});

	test("failed, malformed, and cancelled discovery retains the prior list and can retry", async () => {
		const staticModel = {
			modelId: "static-model",
			protocolId: "retry-wire",
			providerId: "retry-provider",
		};
		const lastKnownModel = {
			modelId: "last-known-model",
			protocolId: "retry-wire",
			providerId: "retry-provider",
		};
		const nextModel = {
			modelId: "newly-published-model",
			protocolId: "retry-wire",
			providerId: "retry-provider",
		};
		const storedModels = new Map<string, readonly (typeof lastKnownModel)[]>();
		const modelStoreWrites: (readonly (typeof lastKnownModel)[])[] = [];
		const modelStore = {
			get: async (providerId: string) => storedModels.get(providerId),
			set: async (
				providerId: string,
				models: readonly (typeof lastKnownModel)[]
			) => {
				modelStoreWrites.push(models);
				storedModels.set(providerId, models);
			},
		};
		const credentials = new Map<string, unknown>();
		const credentialStore = {
			delete: async (providerId: string) => {
				credentials.delete(providerId);
			},
			get: async (providerId: string) => credentials.get(providerId),
			set: async (providerId: string, credential: unknown) => {
				credentials.set(providerId, credential);
			},
		};
		let discoveryMode: "malformed" | "network-failure" | "success" = "success";
		let activeController: AbortController | undefined;
		const provider: Provider = {
			id: "retry-provider",
			models: [staticModel],
			discoverModels: async ({ signal }) => {
				if (discoveryMode === "network-failure") {
					throw new Error("discovery endpoint unavailable");
				}
				if (discoveryMode === "malformed") {
					return [{ ...nextModel, providerId: "wrong-provider" }];
				}
				if (activeController) {
					activeController.abort(
						new DOMException("discovery cancelled", "AbortError")
					);
					expect(signal?.aborted).toBe(true);
				}
				return [
					discoveryMode === "success" && storedModels.size === 0
						? lastKnownModel
						: nextModel,
				];
			},
			resolveAuthorization: async ({ credential }) =>
				credential === "configured" ? { authorization: "token" } : null,
			async *streamChat() {
				yield { delta: "unused", type: "text-delta" };
			},
		};
		const sdk = createProviderCollection({ credentialStore, modelStore });
		sdk.register(provider);
		await sdk.restoreModels();
		await sdk.setCredential("retry-provider", "configured");
		await sdk.refreshModels("retry-provider");
		const previousList = [staticModel, lastKnownModel];
		expect(sdk.getModels()).toEqual(previousList);

		await sdk.deleteCredential("retry-provider");
		await expect(sdk.refreshModels("retry-provider")).rejects.toThrow(
			"has no usable credentials"
		);
		expect(sdk.getModels()).toEqual(previousList);
		expect(storedModels.get("retry-provider")).toEqual([lastKnownModel]);
		await sdk.setCredential("retry-provider", "configured");

		discoveryMode = "network-failure";
		await expect(sdk.refreshModels("retry-provider")).rejects.toThrow(
			"discovery endpoint unavailable"
		);
		expect(sdk.getModels()).toEqual(previousList);
		expect(storedModels.get("retry-provider")).toEqual([lastKnownModel]);

		discoveryMode = "malformed";
		await expect(sdk.refreshModels("retry-provider")).rejects.toThrow(
			"invalid model for provider retry-provider"
		);
		expect(sdk.getModels()).toEqual(previousList);
		expect(storedModels.get("retry-provider")).toEqual([lastKnownModel]);

		discoveryMode = "success";
		const controller = new AbortController();
		activeController = controller;
		await expect(
			sdk.refreshModels("retry-provider", { signal: controller.signal })
		).rejects.toThrow("discovery cancelled");
		activeController = undefined;
		expect(sdk.getModels()).toEqual(previousList);
		expect(storedModels.get("retry-provider")).toEqual([lastKnownModel]);
		expect(modelStoreWrites).toHaveLength(1);

		await sdk.refreshModels("retry-provider");
		expect(sdk.getModels()).toEqual([staticModel, nextModel]);
		expect(storedModels.get("retry-provider")).toEqual([nextModel]);
		expect(modelStoreWrites).toHaveLength(2);
	});

	test("provider continuation travels through the success terminal into the next assistant message", async () => {
		const continuation = [{ id: "rs_private", type: "reasoning" }];
		const receivedContinuations: unknown[] = [];
		const sdk = createProviderCollection();
		sdk.register({
			id: "continuation-provider",
			models: [
				{
					modelId: "continuation-model",
					protocolId: "continuation-wire",
					providerId: "continuation-provider",
				},
			],
			resolveAuthorization: async () => ({ authorization: "configured" }),
			async *streamChat(request) {
				receivedContinuations.push(request.messages[0]?.continuation);
				if (receivedContinuations.length === 1) {
					yield { continuation, type: "finish" };
					return;
				}
				yield { delta: "continued", type: "text-delta" };
			},
		});

		const firstEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{ content: [{ text: "question", type: "text" }], role: "user" },
			],
			modelId: "continuation-model",
			providerId: "continuation-provider",
		})) {
			firstEvents.push(event);
		}
		const terminalEvent = firstEvents.at(-1);
		if (terminalEvent?.type !== "terminal") {
			throw new Error("Expected the first chat to terminate.");
		}

		const secondEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [{ text: "answer", type: "text" }],
					continuation:
						terminalEvent.outcome.status === "success"
							? terminalEvent.outcome.continuation
							: undefined,
					role: "assistant",
				},
			],
			modelId: "continuation-model",
			providerId: "continuation-provider",
		})) {
			secondEvents.push(event);
		}

		expect(firstEvents).toEqual([
			{
				outcome: { continuation, status: "success" },
				type: "terminal",
			},
		]);
		expect(receivedContinuations).toEqual([undefined, continuation]);
		expect(secondEvents.at(-1)).toEqual({
			outcome: { status: "success" },
			type: "terminal",
		});
	});

	test("a provider failure after its finish result does not become a successful terminal", async () => {
		const sdk = createProviderCollection();
		sdk.register({
			...demoProvider(),
			id: "late-failure-provider",
			models: [
				{
					modelId: "late-failure-model",
					protocolId: "late-failure-wire",
					providerId: "late-failure-provider",
				},
			],
			async *streamChat() {
				yield { continuation: "must-not-escape", type: "finish" };
				throw new ProviderError("transport", "stream failed after finish");
			},
		});
		await sdk.setCredential("late-failure-provider", "configured");

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "late-failure-model",
			providerId: "late-failure-provider",
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{
				outcome: {
					failure: {
						code: "transport",
						message: "stream failed after finish",
						providerId: "late-failure-provider",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
	});

	test("an abort after the provider finish result does not leak a successful continuation", async () => {
		const sdk = createProviderCollection();
		sdk.register({
			...demoProvider(),
			id: "late-abort-provider",
			models: [
				{
					modelId: "late-abort-model",
					protocolId: "late-abort-wire",
					providerId: "late-abort-provider",
				},
			],
			async *streamChat() {
				yield { continuation: "must-not-escape", type: "finish" };
				throw new DOMException("cancelled after finish", "AbortError");
			},
		});
		await sdk.setCredential("late-abort-provider", "configured");

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "late-abort-model",
			providerId: "late-abort-provider",
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{
				outcome: {
					reason: "cancelled after finish",
					status: "aborted",
				},
				type: "terminal",
			},
		]);
	});

	test("pre-aborted requests produce one abort terminal event", async () => {
		const sdk = createProviderCollection();
		sdk.register(demoProvider());
		const controller = new AbortController();
		controller.abort("cancelled by caller");

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "demo-model",
			providerId: "demo-provider",
			signal: controller.signal,
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{
				outcome: { reason: "cancelled by caller", status: "aborted" },
				type: "terminal",
			},
		]);
	});
});
