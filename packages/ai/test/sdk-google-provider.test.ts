import { describe, expect, test } from "bun:test";
import { type ChatEvent, createProviderCollection } from "@wincode/ai/sdk";
import {
	createGoogleProvider,
	type GoogleFetch,
} from "@wincode/ai/sdk/providers/google";

const sseResponse = (chunks: readonly Readonly<Record<string, unknown>>[]) =>
	new Response(
		chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);

const input = [
	{
		content: [
			{ text: "Lookup the weather", type: "text" as const },
			{ data: "aW1hZ2U=", mediaType: "image/png", type: "image" as const },
		],
		role: "user" as const,
	},
];

const responseChunks = [
	{
		candidates: [
			{ content: { parts: [{ text: "Reasoning first", thought: true }] } },
		],
	},
	{ candidates: [{ content: { parts: [{ text: "Forecast is sunny." }] } }] },
	{
		candidates: [
			{
				content: {
					parts: [
						{
							functionCall: {
								args: { city: "Paris" },
								id: "call-weather",
								name: "weather",
							},
						},
					],
				},
			},
		],
	},
	{
		candidates: [{ finishReason: "STOP" }],
		usageMetadata: {
			cachedContentTokenCount: 4,
			candidatesTokenCount: 5,
			promptTokenCount: 20,
			thoughtsTokenCount: 3,
			totalTokenCount: 25,
		},
	},
];

describe("public Google SDK provider", () => {
	test("app credentials stream cached multimodal input, reasoning, tools, and normalized usage", async () => {
		const requests: {
			body: Record<string, unknown>;
			headers: Headers;
			url: string;
		}[] = [];
		const cacheCreates: { model: string; config: Record<string, unknown> }[] =
			[];
		const cacheDeletes: { name: string }[] = [];
		const fetch: GoogleFetch = async (inputUrl, init) => {
			requests.push({
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				headers: new Headers(init?.headers),
				url: String(inputUrl),
			});
			return sseResponse(responseChunks);
		};
		const sdk = createProviderCollection();
		const provider = createGoogleProvider({
			createCacheClient: () => ({
				create: async ({ model, config }) => {
					cacheCreates.push({
						model,
						config: config as Record<string, unknown>,
					});
					return { name: "cachedContents/session" };
				},
				delete: async ({ name }) => {
					cacheDeletes.push({ name });
					return {};
				},
			}),
			fetch,
		});
		sdk.register(provider);
		await sdk.setCredential("google", {
			apiKey: "app-owned-google-key",
			kind: "api-key",
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "short",
			messages: input,
			modelId: "gemini-3.8-flash",
			providerId: "google",
			system: "Stable system instructions.",
			tools: [
				{
					name: "weather",
					description: "Get a forecast.",
					inputSchema: {
						properties: { city: { type: "string" } },
						required: ["city"],
						type: "object",
					},
				},
			],
		})) {
			events.push(event);
		}

		expect(provider.id).toBe("google");
		expect(provider.models.map(({ modelId }) => modelId)).toContain(
			"gemini-3.8-flash"
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
		);
		expect(requests[0]?.headers.get("x-goog-api-key")).toBe(
			"app-owned-google-key"
		);
		expect(requests[0]?.body).toMatchObject({
			cachedContent: "cachedContents/session",
			contents: [
				{
					role: "user",
					parts: [
						{ text: "Lookup the weather" },
						{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } },
					],
				},
			],
		});
		expect(requests[0]?.body).not.toHaveProperty("systemInstruction");
		expect(requests[0]?.body).not.toHaveProperty("tools");
		expect(cacheCreates).toEqual([
			{
				model: "gemini-3.8-flash",
				config: {
					systemInstruction: "Stable system instructions.",
					ttl: "300s",
					tools: [
						{
							functionDeclarations: [
								{
									name: "weather",
									description: "Get a forecast.",
									parametersJsonSchema: {
										properties: { city: { type: "string" } },
										required: ["city"],
										type: "object",
									},
								},
							],
						},
					],
				},
			},
		]);
		expect(events).toEqual([
			{ delta: "Reasoning first", type: "reasoning-delta" },
			{ delta: "Forecast is sunny.", type: "text-delta" },
			{
				input: { city: "Paris" },
				toolCallId: "call-weather",
				toolName: "weather",
				type: "tool-call",
			},
			{
				type: "usage",
				usage: {
					cacheReadTokens: 4,
					inputTokens: 20,
					outputTokens: 5,
					reasoningTokens: 3,
					totalTokens: 25,
				},
			},
			{
				type: "terminal",
				outcome: {
					continuation: [
						{ text: "Reasoning first", thought: true },
						{ text: "Forecast is sunny." },
						{
							functionCall: {
								args: { city: "Paris" },
								id: "call-weather",
								name: "weather",
							},
						},
					],
					status: "success",
				},
			},
		]);
		await sdk.close();
		expect(cacheDeletes).toEqual([{ name: "cachedContents/session" }]);
		expect(JSON.stringify(events)).not.toContain("app-owned-google-key");
	});

	test("reuses session CachedContent and retries an invalid resource uncached", async () => {
		let requests = 0;
		const deleted: string[] = [];
		const sdk = createProviderCollection();
		const provider = createGoogleProvider({
			createCacheClient: () => ({
				create: async () => ({ name: `cachedContents/${requests + 1}` }),
				delete: async ({ name }) => {
					deleted.push(name);
					return {};
				},
			}),
			fetch: async () => {
				requests += 1;
				if (requests === 2) {
					return Response.json(
						{ error: { message: "Cached content has expired." } },
						{ status: 400 }
					);
				}
				return sseResponse([{ candidates: [{ finishReason: "STOP" }] }]);
			},
		});
		sdk.register(provider);
		await sdk.setCredential("google", { apiKey: "key", kind: "api-key" });
		const send = async () => {
			for await (const _event of sdk.chat({
				cacheRetention: "short",
				messages: [
					{ content: [{ text: "Hello", type: "text" }], role: "user" },
				],
				modelId: "gemini-3.8-flash",
				providerId: "google",
				system: "Stable prefix",
			})) {
				// Consume the public stream to its terminal outcome.
			}
		};

		await send();
		await send();
		await provider.close();
		expect(requests).toBe(3);
		expect(deleted).toEqual(["cachedContents/1"]);
	});

	test("unsupported cache requests skip creation and supported cache creation failures continue uncached", async () => {
		const bodies: Record<string, unknown>[] = [];
		let creates = 0;
		const sdk = createProviderCollection();
		const provider = createGoogleProvider({
			createCacheClient: () => ({
				create: async () => {
					creates += 1;
					throw new Error("cache service unavailable");
				},
				delete: async () => ({}),
			}),
			fetch: async (_url, init) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return sseResponse([{ candidates: [{ finishReason: "STOP" }] }]);
			},
			models: [
				{
					modelId: "custom-gemini",
					protocolId: "google",
					providerId: "google",
				},
			],
		});
		sdk.register(provider);
		await sdk.setCredential("google", { apiKey: "key", kind: "api-key" });
		for await (const _event of sdk.chat({
			cacheRetention: "short",
			messages: [{ content: [{ text: "Hello", type: "text" }], role: "user" }],
			modelId: "custom-gemini",
			providerId: "google",
			system: "System prefix",
		})) {
			// Consume the terminal outcome.
		}

		expect(creates).toBe(0);
		expect(bodies[0]).toMatchObject({
			systemInstruction: { parts: [{ text: "System prefix" }] },
		});
		await provider.close();

		let cacheCreationAttempts = 0;
		let uncachedBody: Record<string, unknown> | undefined;
		const supportedSdk = createProviderCollection();
		const supportedProvider = createGoogleProvider({
			createCacheClient: () => ({
				create: async () => {
					cacheCreationAttempts += 1;
					throw new Error("cache service unavailable");
				},
				delete: async () => ({}),
			}),
			fetch: async (_url, init) => {
				uncachedBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;
				return sseResponse([{ candidates: [{ finishReason: "STOP" }] }]);
			},
		});
		supportedSdk.register(supportedProvider);
		await supportedSdk.setCredential("google", {
			apiKey: "key",
			kind: "api-key",
		});
		for await (const _event of supportedSdk.chat({
			cacheRetention: "short",
			messages: [{ content: [{ text: "Hello", type: "text" }], role: "user" }],
			modelId: "gemini-3.8-flash",
			providerId: "google",
			system: "System prefix",
		})) {
			// Consume the public stream after the cache manager falls back.
		}
		expect(cacheCreationAttempts).toBe(1);
		expect(uncachedBody).toMatchObject({
			systemInstruction: { parts: [{ text: "System prefix" }] },
		});
		expect(uncachedBody).not.toHaveProperty("cachedContent");
		await supportedProvider.close();
	});

	test("authentication and transport failures remain structured chat outcomes", async () => {
		const reject = createGoogleProvider({
			fetch: async () =>
				Response.json(
					{ error: { message: "invalid API key" } },
					{ status: 401 }
				),
		});
		const sdk = createProviderCollection();
		sdk.register(reject);
		await sdk.setCredential("google", { apiKey: "bad-key", kind: "api-key" });
		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [],
			modelId: "gemini-3.8-flash",
			providerId: "google",
		})) {
			events.push(event);
		}
		expect(events.at(-1)).toEqual({
			outcome: {
				failure: {
					code: "authentication",
					message: "Google rejected the configured credential.",
					providerId: "google",
				},
				status: "failure",
			},
			type: "terminal",
		});
		await reject.close();

		const transport = createGoogleProvider({
			fetch: async () => {
				throw new Error("network is offline");
			},
		});
		const transportSdk = createProviderCollection();
		transportSdk.register(transport);
		await transportSdk.setCredential("google", {
			apiKey: "valid-shape-key",
			kind: "api-key",
		});
		const transportEvents: ChatEvent[] = [];
		for await (const event of transportSdk.chat({
			messages: [],
			modelId: "gemini-3.8-flash",
			providerId: "google",
		})) {
			transportEvents.push(event);
		}
		expect(transportEvents.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "transport", providerId: "google" },
				status: "failure",
			},
			type: "terminal",
		});
		await transport.close();
	});

	test("provider refusals and aborts remain structured chat terminal outcomes", async () => {
		const providerFailure = createGoogleProvider({
			fetch: async () =>
				Response.json({ error: { message: "service error" } }, { status: 500 }),
		});
		const providerSdk = createProviderCollection();
		providerSdk.register(providerFailure);
		await providerSdk.setCredential("google", {
			apiKey: "key",
			kind: "api-key",
		});
		const providerEvents: ChatEvent[] = [];
		for await (const event of providerSdk.chat({
			messages: [],
			modelId: "gemini-3.8-flash",
			providerId: "google",
		})) {
			providerEvents.push(event);
		}
		expect(providerEvents.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "provider", providerId: "google" },
				status: "failure",
			},
			type: "terminal",
		});
		await providerFailure.close();

		const controller = new AbortController();
		const abortingProvider = createGoogleProvider({
			fetch: async () => {
				let sentText = false;
				const body = new ReadableStream<Uint8Array>(
					{
						pull(streamController) {
							if (!sentText) {
								sentText = true;
								streamController.enqueue(
									new TextEncoder().encode(
										'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}' +
											String.fromCharCode(10, 10)
									)
								);
								return;
							}
							controller.abort(
								new DOMException("caller stopped", "AbortError")
							);
							streamController.close();
						},
					},
					{ highWaterMark: 0 }
				);
				return new Response(body, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		const abortSdk = createProviderCollection();
		abortSdk.register(abortingProvider);
		await abortSdk.setCredential("google", { apiKey: "key", kind: "api-key" });
		const abortEvents: ChatEvent[] = [];
		for await (const event of abortSdk.chat({
			messages: [],
			modelId: "gemini-3.8-flash",
			providerId: "google",
			signal: controller.signal,
		})) {
			abortEvents.push(event);
		}
		expect(abortEvents).toContainEqual({
			delta: "partial",
			type: "text-delta",
		});
		expect(abortEvents.at(-1)).toEqual({
			outcome: { reason: "caller stopped", status: "aborted" },
			type: "terminal",
		});
		await abortingProvider.close();
	});
});
