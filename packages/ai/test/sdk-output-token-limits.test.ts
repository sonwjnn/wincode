import { describe, expect, test } from "bun:test";
import {
	type ChatEvent,
	type ChatRequest,
	createProviderCollection,
	maxOutputTokensForRequest,
	type Provider,
	type ProviderModel,
} from "../src/sdk.ts";
import { createAnthropicProvider } from "../src/sdk-providers/anthropic.ts";
import { createDeepSeekProvider } from "../src/sdk-providers/deepseek.ts";
import { createGoogleProvider } from "../src/sdk-providers/google.ts";
import { createOpenAIProvider } from "../src/sdk-providers/openai.ts";
import { createOpenCodeGoProvider } from "../src/sdk-providers/opencode-go.ts";
import { createOpenRouterProvider } from "../src/sdk-providers/openrouter.ts";

const responseFor = (body: string): Response =>
	new Response(body, { headers: { "content-type": "text/event-stream" } });

const openAIResponsesResponse = (): Response =>
	responseFor(
		'event: response.completed\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
	);

const openAIChatResponse = (): Response =>
	responseFor(
		[
			'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
			"data: [DONE]\n\n",
		].join("")
	);

const anthropicResponse = (): Response =>
	responseFor(
		[
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-limit","type":"message","role":"assistant","model":"fixture","content":[],"stop_reason":null,"usage":{"input_tokens":2}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("")
	);

const googleResponse = (): Response =>
	responseFor(
		[
			'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n',
			'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3}}\n\n',
		].join("")
	);

const runChat = async (
	provider: Provider,
	providerId: string,
	modelId: string,
	credential: unknown,
	options: Readonly<{ cacheWarming?: true; maxOutputTokens?: number }> = {}
): Promise<readonly ChatEvent[]> => {
	const collection = createProviderCollection();
	collection.register(provider);
	await collection.setCredential(providerId, credential);
	const events: ChatEvent[] = [];
	for await (const event of collection.chat({
		...options,
		messages: [
			{ content: [{ text: "Say hello", type: "text" }], role: "user" },
		],
		modelId,
		providerId,
	})) {
		events.push(event);
	}
	await collection.close();
	return events;
};

const wireModel = (
	providerId: string,
	modelId: string,
	protocolId: string,
	maxOutputTokens = 64
): ProviderModel => ({
	limits: { contextWindowTokens: 4096, maxOutputTokens },
	modelId,
	protocolId,
	providerId,
});

const apiKeyCredential = (apiKey: string) => ({ apiKey, kind: "api-key" });

const requestBody = (init: RequestInit | undefined): Record<string, unknown> =>
	JSON.parse(String(init?.body)) as Record<string, unknown>;

describe("Provider Model output-token limits", () => {
	test("rejects invalid Provider Model output ceilings and explicit request caps", async () => {
		const invalidMaxima = [
			0,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		const collection = createProviderCollection();
		for (const [index, maximum] of invalidMaxima.entries()) {
			const model = wireModel(
				"fixture",
				`invalid-limit-${index}`,
				"fixture",
				maximum
			);
			expect(() => maxOutputTokensForRequest(16, model)).toThrow(
				"Provider Model maxOutputTokens must be a positive safe integer."
			);
			expect(() =>
				collection.register({
					id: "fixture",
					models: [model],
					resolveAuthorization: () => ({ authorization: "fixture-only" }),
					async *streamChat() {
						yield { type: "finish" };
					},
				})
			).toThrow("Invalid model identity for provider fixture.");
		}
		await collection.close();
	});

	test("rejects invalid context limits at registration, discovery, and restoration", async () => {
		const invalidContextLimits = [
			0,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		const providerFor = (
			models: readonly ProviderModel[],
			discoverModels?: Provider["discoverModels"]
		): Provider => ({
			...(discoverModels === undefined ? {} : { discoverModels }),
			id: "fixture",
			models,
			resolveAuthorization: () => ({ authorization: "fixture-only" }),
			async *streamChat() {
				yield { type: "finish" };
			},
		});

		for (const [index, contextWindowTokens] of invalidContextLimits.entries()) {
			const invalidModel: ProviderModel = {
				limits: { contextWindowTokens },
				modelId: `invalid-context-${index}`,
				protocolId: "fixture",
				providerId: "fixture",
			};
			const registrationCollection = createProviderCollection();
			expect(() =>
				registrationCollection.register(providerFor([invalidModel]))
			).toThrow("Invalid model identity for provider fixture.");
			await registrationCollection.close();

			const discoveryCollection = createProviderCollection();
			discoveryCollection.register(providerFor([], () => [invalidModel]));
			await expect(
				discoveryCollection.refreshModels("fixture")
			).rejects.toThrow(
				"Provider discovery contains an invalid model for provider fixture."
			);
			expect(
				discoveryCollection.getModel("fixture", invalidModel.modelId)
			).toBeUndefined();
			await discoveryCollection.close();

			const restorationCollection = createProviderCollection({
				modelStore: {
					get: () => [invalidModel],
					set: async () => undefined,
				},
			});
			restorationCollection.register(providerFor([]));
			await expect(restorationCollection.restoreModels()).rejects.toThrow(
				"Model store snapshot contains an invalid model for provider fixture."
			);
			expect(
				restorationCollection.getModel("fixture", invalidModel.modelId)
			).toBeUndefined();
			await restorationCollection.close();
		}
	});

	test("normalizes registered and discovered Provider Model pricing tiers", async () => {
		const pricing: NonNullable<ProviderModel["pricing"]> = {
			inputPerMillionTokensUsd: 1,
			outputPerMillionTokensUsd: 2,
			tiers: [
				{
					inputPerMillionTokensUsd: 20,
					inputTokensAbove: 500,
					outputPerMillionTokensUsd: 40,
				},
				{
					inputPerMillionTokensUsd: 2,
					inputTokensAbove: 200,
					outputPerMillionTokensUsd: 4,
				},
			],
		};
		const staticModel: ProviderModel = {
			...wireModel("fixture", "static", "fixture"),
			pricing,
		};
		const discoveredModel: ProviderModel = {
			...wireModel("fixture", "discovered", "fixture"),
			pricing,
		};
		const collection = createProviderCollection();
		collection.register({
			discoverModels: () => [discoveredModel],
			id: "fixture",
			models: [staticModel],
			resolveAuthorization: () => ({ authorization: "fixture-only" }),
			async *streamChat() {
				yield { type: "finish" };
			},
		});
		const tierThresholds = (modelId: string) =>
			collection
				.getModel("fixture", modelId)
				?.pricing?.tiers?.map(({ inputTokensAbove }) => inputTokensAbove);

		expect(tierThresholds("static")).toEqual([200, 500]);
		await collection.refreshModels("fixture");
		expect(tierThresholds("discovered")).toEqual([200, 500]);
		await collection.close();
	});

	test("rejects invalid public SDK output budgets before provider dispatch or clamping", async () => {
		let authorizationCalls = 0;
		let streamCalls = 0;
		const provider: Provider = {
			id: "fixture",
			models: [wireModel("fixture", "limited", "fixture", 32)],
			resolveAuthorization: () => {
				authorizationCalls += 1;
				return { authorization: "fixture-only" };
			},
			async *streamChat() {
				streamCalls += 1;
				yield { type: "finish" };
			},
		};
		const collection = createProviderCollection();
		collection.register(provider);
		await collection.setCredential("fixture", { token: "fixture-only" });
		const invalidBudgets = [
			0,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		const consume = async (request: ChatRequest): Promise<void> => {
			for await (const _event of collection.chat(request)) {
				// The request must reject before any provider event is produced.
			}
		};

		for (const [index, maxOutputTokens] of invalidBudgets.entries()) {
			const request: ChatRequest = {
				...(index === 0 ? { cacheWarming: true as const } : {}),
				maxOutputTokens,
				messages: [
					{
						content: [{ text: "invalid cap", type: "text" }],
						role: "user",
					},
				],
				modelId: "limited",
				providerId: "fixture",
			};
			await expect(consume(request)).rejects.toThrow(
				"maxOutputTokens must be a positive safe integer."
			);
		}

		expect(authorizationCalls).toBe(0);
		expect(streamCalls).toBe(0);
		await collection.close();
	});

	test("OpenAI Responses and Chat Completions clamp to their exact model output limit", async () => {
		const requests: Record<string, unknown>[] = [];
		const provider = createOpenAIProvider({
			fetch: async (input, init) => {
				requests.push(requestBody(init));
				return String(input).endsWith("/responses")
					? openAIResponsesResponse()
					: openAIChatResponse();
			},
			models: [
				wireModel("openai", "responses-limit", "openai-responses", 32),
				wireModel("openai", "chat-limit", "openai-chat", 48),
			],
		});
		for (const modelId of ["responses-limit", "chat-limit"]) {
			const events = await runChat(
				provider,
				"openai",
				modelId,
				{ apiKey: "fake-openai-key", kind: "api-key" },
				{ maxOutputTokens: 1000 }
			);
			expect(events.at(-1)).toMatchObject({
				type: "terminal",
				outcome: { status: "success" },
			});
		}
		expect(requests[0]).toHaveProperty("max_output_tokens", 32);
		expect(requests[1]).toHaveProperty("max_tokens", 48);
	});

	test("OpenAI OAuth fails closed before network I/O when a bounded request cannot be enforced", async () => {
		let requests = 0;
		const provider = createOpenAIProvider({
			fetch: async () => {
				requests += 1;
				return openAIResponsesResponse();
			},
			models: [wireModel("openai", "oauth-limit", "openai-responses")],
		});
		const oauthCredential = {
			accessToken: "fake-oauth-access-token",
			accountId: "fake-account",
			expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
			kind: "oauth-session",
			refreshToken: "fake-oauth-refresh-token",
			updatedAt: new Date().toISOString(),
		};
		const events = await runChat(
			provider,
			"openai",
			"oauth-limit",
			oauthCredential,
			{ maxOutputTokens: 20 }
		);
		const warmingEvents = await runChat(
			provider,
			"openai",
			"oauth-limit",
			oauthCredential,
			{ cacheWarming: true }
		);
		expect(events.at(-1)).toMatchObject({
			type: "terminal",
			outcome: {
				status: "failure",
				failure: {
					code: "unsupported-capability",
					modelId: "oauth-limit",
					providerId: "openai",
				},
			},
		});
		expect(warmingEvents.at(-1)).toMatchObject({
			type: "terminal",
			outcome: {
				status: "failure",
				failure: {
					code: "unsupported-capability",
					modelId: "oauth-limit",
					providerId: "openai",
				},
			},
		});
		expect(requests).toBe(0);
	});

	test("OpenAI output-cap capability detects OAuth without resolving authorization", async () => {
		let authorizationCalls = 0;
		let fetchCalls = 0;
		const openAIProvider = createOpenAIProvider({
			fetch: async () => {
				fetchCalls += 1;
				return openAIResponsesResponse();
			},
			models: [wireModel("openai", "oauth-capability", "openai-responses")],
		});
		const provider: Provider = {
			...openAIProvider,
			resolveAuthorization: (input) => {
				authorizationCalls += 1;
				return openAIProvider.resolveAuthorization(input);
			},
		};
		const collection = createProviderCollection();
		collection.register(provider);
		await collection.setCredential("openai", {
			accessToken: "fake-oauth-access-token",
			accountId: "fake-account",
			expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
			kind: "oauth-session",
			refreshToken: "fake-oauth-refresh-token",
			updatedAt: new Date().toISOString(),
		});

		expect(
			await collection.canEnforceMaxOutputTokens("openai", "oauth-capability")
		).toBe(false);
		await collection.setCredential("openai", {
			apiKey: "fake-openai-api-key",
			kind: "api-key",
		});
		expect(
			await collection.canEnforceMaxOutputTokens("openai", "oauth-capability")
		).toBe(true);
		expect(authorizationCalls).toBe(0);
		expect(fetchCalls).toBe(0);
		await collection.close();
	});

	test("Anthropic Messages clamps a request to the exact published model output limit", async () => {
		let body: Record<string, unknown> | undefined;
		const provider = createAnthropicProvider({
			fetch: async (_input, init) => {
				body = requestBody(init);
				return anthropicResponse();
			},
			models: [wireModel("anthropic", "anthropic-limit", "anthropic", 80)],
		});
		const events = await runChat(
			provider,
			"anthropic",
			"anthropic-limit",
			apiKeyCredential("fake-anthropic-key"),
			{ maxOutputTokens: 200 }
		);
		expect(body).toHaveProperty("max_tokens", 80);
		expect(events.at(-1)).toMatchObject({
			type: "terminal",
			outcome: { status: "success" },
		});
	});

	test("Google GenerateContent clamps to the exact Provider Model output limit", async () => {
		let body: Record<string, unknown> | undefined;
		const provider = createGoogleProvider({
			fetch: async (_input, init) => {
				body = requestBody(init);
				return googleResponse();
			},
			models: [wireModel("google", "google-limit", "google", 96)],
		});
		const events = await runChat(
			provider,
			"google",
			"google-limit",
			apiKeyCredential("fake-google-key"),
			{ maxOutputTokens: 200 }
		);
		expect(body).toHaveProperty("generationConfig.maxOutputTokens", 96);
		expect(events.at(-1)).toMatchObject({
			type: "terminal",
			outcome: { status: "success" },
		});
	});

	test("OpenCode Go forwards the cap through Responses, Messages, and compatible routes", async () => {
		const bodies = new Map<string, Record<string, unknown>>();
		const provider = createOpenCodeGoProvider({
			fetch: async (input, init) => {
				const url = String(input);
				const model = requestBody(init);
				bodies.set(String(model.model), model);
				if (url.endsWith("/responses")) {
					return openAIResponsesResponse();
				}
				if (url.endsWith("/messages")) {
					return anthropicResponse();
				}
				return openAIChatResponse();
			},
			models: [
				wireModel("opencode-go", "go-responses", "openai-responses", 41),
				wireModel("opencode-go", "go-messages", "anthropic", 42),
				wireModel("opencode-go", "go-compatible", "openai-compatible", 43),
			],
		});
		for (const modelId of ["go-responses", "go-messages", "go-compatible"]) {
			const events = await runChat(
				provider,
				"opencode-go",
				modelId,
				apiKeyCredential("fake-opencode-key"),
				{ maxOutputTokens: 100 }
			);
			expect(events.at(-1)).toMatchObject({
				type: "terminal",
				outcome: { status: "success" },
			});
		}
		expect(bodies.get("go-responses")).toHaveProperty("max_output_tokens", 41);
		expect(bodies.get("go-messages")).toHaveProperty("max_tokens", 42);
		expect(bodies.get("go-compatible")).toHaveProperty("max_tokens", 43);
	});

	test("DeepSeek OpenAI-compatible chat enforces normal and cache-warm output caps", async () => {
		const bodies: Record<string, unknown>[] = [];
		const provider = createDeepSeekProvider({
			fetch: async (_input, init) => {
				bodies.push(requestBody(init));
				return openAIChatResponse();
			},
		});
		const normal = await runChat(
			provider,
			"deepseek",
			"deepseek-chat",
			apiKeyCredential("fake-deepseek-key"),
			{ maxOutputTokens: 321 }
		);
		const warming = await runChat(
			provider,
			"deepseek",
			"deepseek-chat",
			apiKeyCredential("fake-deepseek-key"),
			{ cacheWarming: true, maxOutputTokens: 321 }
		);
		expect(normal.at(-1)).toMatchObject({
			type: "terminal",
			outcome: { status: "success" },
		});
		expect(warming.at(-1)).toMatchObject({
			type: "terminal",
			outcome: { status: "success" },
		});
		expect(bodies[0]).toHaveProperty("max_tokens", 321);
		expect(bodies[1]).toHaveProperty("max_tokens", 1);
	});

	test("OpenRouter discovery preserves exact limits and prices and its route clamps output", async () => {
		const requests: {
			body: Record<string, unknown>;
			method: string;
			url: string;
		}[] = [];
		const provider = createOpenRouterProvider({
			baseUrl: "https://openrouter.test/api/v1/",
			fetch: async (input, init) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (method === "GET") {
					return Response.json({
						data: [
							{
								id: "fixture/model",
								context_length: 12_000,
								top_provider: { max_completion_tokens: 64 },
								pricing: {
									prompt: "0.000002",
									completion: "0.000006",
									input_cache_read: "0.0000002",
									input_cache_write: "0.000003",
								},
							},
						],
					});
				}
				requests.push({
					body: requestBody(init),
					method,
					url,
				});
				return openAIChatResponse();
			},
		});
		const collection = createProviderCollection();
		collection.register(provider);
		await collection.setCredential(
			"openrouter",
			apiKeyCredential("fake-openrouter-key")
		);
		await collection.refreshModels("openrouter");
		const model = collection.getModel("openrouter", "fixture/model");
		expect(model).toMatchObject({
			limits: { contextWindowTokens: 12_000, maxOutputTokens: 64 },
			pricing: {
				inputPerMillionTokensUsd: 2,
				outputPerMillionTokensUsd: 6,
				cacheWritePerMillionTokensUsd: 3,
			},
		});
		expect(model?.pricing?.cacheReadPerMillionTokensUsd).toBeCloseTo(0.2, 12);
		const events: ChatEvent[] = [];
		for await (const event of collection.chat({
			maxOutputTokens: 500,
			messages: [
				{ content: [{ text: "Say hello", type: "text" }], role: "user" },
			],
			modelId: "fixture/model",
			providerId: "openrouter",
		})) {
			events.push(event);
		}
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://openrouter.test/api/v1/chat/completions"
		);
		expect(requests[0]?.body).toHaveProperty("max_tokens", 64);
		expect(events.at(-1)).toMatchObject({
			type: "terminal",
			outcome: { status: "success" },
		});
		await collection.close();
	});
});
