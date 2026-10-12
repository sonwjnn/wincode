import { describe, expect, test } from "bun:test";
import {
	type ChatEvent,
	type ChatMessage,
	createProviderCollection,
	type Provider,
	type ProviderChatEvent,
	ProviderError,
} from "@wincode/ai/sdk";

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
