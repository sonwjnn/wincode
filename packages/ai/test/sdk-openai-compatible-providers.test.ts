import { describe, expect, test } from "bun:test";
import {
	type ChatEvent,
	createProviderCollection,
	type Provider,
	type ProviderModel,
} from "@wincode/ai/sdk";
import { createDeepSeekProvider } from "@wincode/ai/sdk/providers/deepseek";
import {
	createOpenAIProvider,
	type OpenAIProviderOptions,
} from "@wincode/ai/sdk/providers/openai";
import { createOpenRouterProvider } from "@wincode/ai/sdk/providers/openrouter";

const sseResponse = (events: readonly Readonly<Record<string, unknown>>[]) =>
	new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } }
	);

describe("public OpenAI-compatible SDK providers", () => {
	test("DeepSeek baseline stays known offline and streams API-key chat without cache controls", async () => {
		const credentialValues = new Map<string, unknown>();
		const credentialStore = {
			delete: (providerId: string) => {
				credentialValues.delete(providerId);
			},
			get: (providerId: string) => credentialValues.get(providerId),
			set: (providerId: string, credential: unknown) => {
				credentialValues.set(providerId, credential);
			},
		};
		const requests: {
			body: Record<string, unknown>;
			headers: Headers;
			url: string;
		}[] = [];
		const sdk = createProviderCollection({ credentialStore });
		sdk.register(
			createDeepSeekProvider({
				fetch: async (input, init) => {
					requests.push({
						body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						headers: new Headers(init?.headers),
						url: String(input),
					});
					return sseResponse([
						{ choices: [{ delta: { content: "Answer" } }] },
						{ choices: [{ delta: { reasoning_content: "Reasoning" } }] },
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{
												id: "call-weather",
												index: 0,
												type: "function",
												function: {
													arguments: '{"city":"Paris"}',
													name: "weather",
												},
											},
										],
									},
									finish_reason: null,
								},
							],
						},
						{
							choices: [{ delta: {}, finish_reason: "tool_calls" }],
							usage: {
								prompt_tokens: 20,
								completion_tokens: 4,
								total_tokens: 24,
								completion_tokens_details: { reasoning_tokens: 2 },
							},
						},
					]);
				},
			})
		);
		await sdk.setCredential("deepseek", {
			apiKey: "deepseek-test-key",
			kind: "api-key",
		});

		expect(sdk.getModels()).toEqual([
			{
				capabilities: ["text", "tools"],
				modelId: "deepseek-chat",
				protocolId: "openai-compatible",
				providerId: "deepseek",
			},
			{
				capabilities: ["reasoning", "text", "tools"],
				modelId: "deepseek-reasoner",
				protocolId: "openai-compatible",
				providerId: "deepseek",
			},
		]);
		expect(await sdk.getAvailable()).toEqual(sdk.getModels());

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "long",
			messages: [
				{ content: [{ text: "Forecast?", type: "text" }], role: "user" },
			],
			modelId: "deepseek-reasoner",
			providerId: "deepseek",
			system: "Be useful.",
			tools: [
				{
					inputSchema: {
						properties: { city: { type: "string" } },
						type: "object",
					},
					name: "weather",
				},
			],
		})) {
			events.push(event);
		}

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.deepseek.com/chat/completions");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer deepseek-test-key"
		);
		expect(requests[0]?.body).toMatchObject({
			model: "deepseek-reasoner",
			stream: true,
			stream_options: { include_usage: true },
			messages: [
				{ role: "system", content: "Be useful." },
				{ role: "user", content: "Forecast?" },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "weather",
						parameters: {
							properties: { city: { type: "string" } },
							type: "object",
						},
					},
				},
			],
		});
		expect(requests[0]?.body).not.toHaveProperty("prompt_cache_key");
		expect(requests[0]?.body).not.toHaveProperty("prompt_cache_options");
		expect(events).toEqual([
			{ delta: "Answer", type: "text-delta" },
			{ delta: "Reasoning", type: "reasoning-delta" },
			{
				input: { city: "Paris" },
				toolCallId: "call-weather",
				toolName: "weather",
				type: "tool-call",
			},
			{
				type: "usage",
				usage: {
					inputTokens: 20,
					outputTokens: 4,
					reasoningTokens: 2,
					totalTokens: 24,
				},
			},
			{ outcome: { status: "success" }, type: "terminal" },
		]);
		expect(JSON.stringify(events)).not.toContain("deepseek-test-key");

		const followUpEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "short",
			messages: [
				{
					content: [
						{ text: "Checking the forecast.", type: "text" },
						{
							input: { city: "Paris" },
							toolCallId: "call-weather",
							toolName: "weather",
							type: "tool-call",
						},
					],
					continuation: { providerToken: "not-a-chat-completions-field" },
					role: "assistant",
				},
				{
					content: [
						{
							errorText: "Weather lookup failed.",
							failure: { kind: "timeout" },
							toolCallId: "call-weather",
							toolName: "weather",
							type: "tool-failure",
						},
					],
					role: "tool",
				},
			],
			modelId: "deepseek-reasoner",
			providerId: "deepseek",
		})) {
			followUpEvents.push(event);
		}
		expect(requests).toHaveLength(2);
		expect(requests[1]?.body.messages).toEqual([
			{
				content: "Checking the forecast.",
				role: "assistant",
				tool_calls: [
					{
						function: { arguments: '{"city":"Paris"}', name: "weather" },
						id: "call-weather",
						type: "function",
					},
				],
			},
			{
				content: "Weather lookup failed.",
				role: "tool",
				tool_call_id: "call-weather",
			},
		]);
		expect(JSON.stringify(requests[1]?.body)).not.toContain(
			"not-a-chat-completions-field"
		);
		expect(followUpEvents.at(-1)).toMatchObject({
			outcome: { status: "success" },
			type: "terminal",
		});
	});

	test("OpenRouter discovery selects exact Provider Model IDs and restores the last-known list offline", async () => {
		const modelSnapshots = new Map<string, readonly ProviderModel[]>();
		const modelStore = {
			get: (providerId: string) => modelSnapshots.get(providerId),
			set: (providerId: string, models: readonly ProviderModel[]) => {
				modelSnapshots.set(providerId, models);
			},
		};
		const calls: { body?: Record<string, unknown>; url: string }[] = [];
		const online = createProviderCollection({ modelStore });
		online.register(
			createOpenRouterProvider({
				fetch: async (input, init) => {
					const url = String(input);
					calls.push({
						...(init?.body === undefined
							? {}
							: {
									body: JSON.parse(String(init.body)) as Record<
										string,
										unknown
									>,
								}),
						url,
					});
					if (url.endsWith("/models")) {
						return Response.json({
							data: [
								{
									context_length: 8192,
									id: "vendor/model-live",
									pricing: { completion: "0.000002", prompt: "0.000001" },
									top_provider: { max_completion_tokens: 2048 },
								},
							],
						});
					}
					return sseResponse([
						{ choices: [{ delta: { content: "OpenRouter response" } }] },
						{
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: {
								prompt_tokens: 3,
								completion_tokens: 2,
								total_tokens: 5,
							},
						},
					]);
				},
			})
		);
		expect(online.getModels()).toEqual([]);
		await online.setCredential("openrouter", {
			apiKey: "openrouter-test-key",
			kind: "api-key",
		});
		const discovered = await online.refreshModels("openrouter");
		expect(discovered).toEqual([
			{
				limits: { contextWindowTokens: 8192, maxOutputTokens: 2048 },
				modelId: "vendor/model-live",
				pricing: {
					inputPerMillionTokensUsd: 1,
					outputPerMillionTokensUsd: 2,
				},
				protocolId: "openai-compatible",
				providerId: "openrouter",
			},
		]);
		const serializedSelection = JSON.parse(
			JSON.stringify(discovered[0])
		) as ProviderModel;
		const chatEvents: ChatEvent[] = [];
		for await (const event of online.chat({
			cacheRetention: "short",
			messages: [{ content: [{ text: "Hello", type: "text" }], role: "user" }],
			modelId: serializedSelection.modelId,
			providerId: serializedSelection.providerId,
		})) {
			chatEvents.push(event);
		}
		expect(calls.map((call) => call.url)).toEqual([
			"https://openrouter.ai/api/v1/models",
			"https://openrouter.ai/api/v1/chat/completions",
		]);
		expect(calls[1]?.body?.model).toBe("vendor/model-live");
		expect(calls[1]?.body).not.toHaveProperty("prompt_cache_key");
		expect(calls[1]?.body).not.toHaveProperty("prompt_cache_options");
		expect(chatEvents.at(-1)).toEqual({
			outcome: { status: "success" },
			type: "terminal",
		});
		expect(JSON.stringify(chatEvents)).not.toContain("openrouter-test-key");

		const offline = createProviderCollection({ modelStore });
		offline.register(
			createOpenRouterProvider({
				fetch: async () => {
					throw new Error("offline consumer must not make a request");
				},
			})
		);
		await offline.restoreModels();
		expect(offline.getModels()).toEqual(discovered);
		expect(await offline.getAvailable()).toEqual([]);
		await offline.setCredential("openrouter", {
			apiKey: "offline-openrouter-key",
			kind: "api-key",
		});
		expect(await offline.getAvailable()).toEqual(discovered);
	});

	test("DeepSeek and OpenRouter use separate OpenAI-compatible routes and credentials without redirecting OpenAI", async () => {
		const calls: { authorization: string | null; url: string }[] = [];
		const openAIResponse = new Response(
			[
				'data: {"type":"response.output_text.delta","delta":"OpenAI response"}\n\n',
				'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
			].join(""),
			{ headers: { "content-type": "text/event-stream" } }
		);
		const compatibleResponse = sseResponse([
			{ choices: [{ delta: { content: "Compatible response" } }] },
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
			},
		]);
		// The existing OpenAI adapter's fetch Response and Bun's test Response types differ.
		const openAIFetch = (async (
			input: string | URL | Request,
			init?: RequestInit
		) => {
			calls.push({
				authorization: new Headers(init?.headers).get("authorization"),
				url: String(input),
			});
			return openAIResponse.clone();
		}) as unknown as NonNullable<OpenAIProviderOptions["fetch"]>;
		const sdk = createProviderCollection();
		sdk.register(
			createDeepSeekProvider({
				fetch: async (input, init) => {
					calls.push({
						authorization: new Headers(init?.headers).get("authorization"),
						url: String(input),
					});
					return compatibleResponse.clone();
				},
			})
		);
		sdk.register(
			createOpenRouterProvider({
				fetch: async (input, init) => {
					calls.push({
						authorization: new Headers(init?.headers).get("authorization"),
						url: String(input),
					});
					return String(input).endsWith("/models")
						? Response.json({ data: [{ id: "route/model" }] })
						: compatibleResponse.clone();
				},
			})
		);
		sdk.register(createOpenAIProvider({ fetch: openAIFetch }));
		await sdk.setCredential("deepseek", {
			apiKey: "deepseek-route-key",
			kind: "api-key",
		});
		await sdk.setCredential("openrouter", {
			apiKey: "openrouter-route-key",
			kind: "api-key",
		});
		await sdk.setCredential("openai", {
			apiKey: "openai-route-key",
			kind: "api-key",
		});
		await sdk.refreshModels("openrouter");
		expect(sdk.getModel("deepseek", "deepseek-chat")?.protocolId).toBe(
			"openai-compatible"
		);
		expect(sdk.getModel("openrouter", "route/model")?.protocolId).toBe(
			"openai-compatible"
		);
		expect(sdk.getModel("openai", "gpt-5.6")?.protocolId).toBe(
			"openai-responses"
		);

		const eventsByProvider = new Map<string, ChatEvent[]>();
		for (const [providerId, modelId] of [
			["deepseek", "deepseek-chat"],
			["openrouter", "route/model"],
			["openai", "gpt-5.6"],
		] as const) {
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				cacheRetention: "short",
				messages: [
					{ content: [{ text: "hello", type: "text" }], role: "user" },
				],
				modelId,
				providerId,
			})) {
				events.push(event);
			}
			eventsByProvider.set(providerId, events);
		}

		expect(calls).toEqual([
			{
				authorization: "Bearer openrouter-route-key",
				url: "https://openrouter.ai/api/v1/models",
			},
			{
				authorization: "Bearer deepseek-route-key",
				url: "https://api.deepseek.com/chat/completions",
			},
			{
				authorization: "Bearer openrouter-route-key",
				url: "https://openrouter.ai/api/v1/chat/completions",
			},
			{
				authorization: "Bearer openai-route-key",
				url: "https://api.openai.com/v1/responses",
			},
		]);
		for (const events of eventsByProvider.values()) {
			expect(events.at(-1)).toMatchObject({
				outcome: { status: "success" },
				type: "terminal",
			});
			expect(JSON.stringify(events)).not.toContain("-route-key");
		}
	});

	test("OpenRouter cancellation wins when a non-OK discovery response races with abort", async () => {
		const controller = new AbortController();
		let returnFailure = false;
		const sdk = createProviderCollection();
		sdk.register(
			createOpenRouterProvider({
				fetch: async (_input, init) => {
					if (returnFailure) {
						if (!init?.signal) {
							throw new Error("discovery did not receive cancellation");
						}
						return new Response(
							new ReadableStream<Uint8Array>({
								cancel() {
									controller.abort(
										new DOMException(
											"OpenRouter refresh cancelled",
											"AbortError"
										)
									);
								},
							}),
							{ status: 503 }
						);
					}
					return Response.json({ data: [{ id: "stable/model" }] });
				},
			})
		);
		await sdk.setCredential("openrouter", {
			apiKey: "discovery-race-key",
			kind: "api-key",
		});
		const knownModels = await sdk.refreshModels("openrouter");
		returnFailure = true;

		await expect(
			sdk.refreshModels("openrouter", { signal: controller.signal })
		).rejects.toThrow("OpenRouter refresh cancelled");
		expect(sdk.getModels()).toEqual(knownModels);
	});

	test("mid-stream body read failures terminate as transport without exposing diagnostics", async () => {
		const sdk = createProviderCollection();
		let firstChunkSent = false;
		sdk.register(
			createDeepSeekProvider({
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								if (firstChunkSent) {
									controller.error(
										new Error("private socket reset diagnostics")
									);
									return;
								}
								firstChunkSent = true;
								controller.enqueue(
									new TextEncoder().encode(
										'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
									)
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } }
					),
			})
		);
		await sdk.setCredential("deepseek", {
			apiKey: "stream-transport-test-key",
			kind: "api-key",
		});
		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [{ content: [{ text: "hello", type: "text" }], role: "user" }],
			modelId: "deepseek-chat",
			providerId: "deepseek",
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{ delta: "partial", type: "text-delta" },
			{
				outcome: {
					failure: {
						code: "transport",
						message: "DeepSeek response stream failed.",
						providerId: "deepseek",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
		expect(JSON.stringify(events)).not.toContain(
			"private socket reset diagnostics"
		);
		expect(JSON.stringify(events)).not.toContain("stream-transport-test-key");
	});

	test("compatible SSE errors retain provider and authentication failure categories", async () => {
		const terminalForStatus = async (status: number) => {
			const sdk = createProviderCollection();
			sdk.register(
				createDeepSeekProvider({
					fetch: async () =>
						sseResponse([
							{ error: { message: "private provider diagnostic", status } },
						]),
				})
			);
			await sdk.setCredential("deepseek", {
				apiKey: "protocol-error-test-key",
				kind: "api-key",
			});
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [
					{ content: [{ text: "hello", type: "text" }], role: "user" },
				],
				modelId: "deepseek-chat",
				providerId: "deepseek",
			})) {
				events.push(event);
			}
			return events.at(-1);
		};

		expect(await terminalForStatus(503)).toMatchObject({
			outcome: { failure: { code: "provider" }, status: "failure" },
			type: "terminal",
		});
		expect(await terminalForStatus(401)).toMatchObject({
			outcome: { failure: { code: "authentication" }, status: "failure" },
			type: "terminal",
		});
	});

	test("compatible provider HTTP failures and mid-stream aborts are terminal without credential leakage", async () => {
		const collect = async (provider: Provider, signal?: AbortSignal) => {
			const sdk = createProviderCollection();
			sdk.register(provider);
			await sdk.setCredential("deepseek", {
				apiKey: "terminal-test-secret",
				kind: "api-key",
			});
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [
					{ content: [{ text: "hello", type: "text" }], role: "user" },
				],
				modelId: "deepseek-chat",
				providerId: "deepseek",
				signal,
			})) {
				events.push(event);
			}
			return events;
		};
		const failure = await collect(
			createDeepSeekProvider({
				fetch: async () =>
					Response.json({ error: "unavailable" }, { status: 503 }),
			})
		);
		expect(failure).toEqual([
			{
				outcome: {
					failure: {
						code: "provider",
						message: "DeepSeek request failed (503).",
						providerId: "deepseek",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
		expect(JSON.stringify(failure)).not.toContain("terminal-test-secret");

		const racingController = new AbortController();
		const abortWinsHttpFailure = await collect(
			createDeepSeekProvider({
				fetch: async () => {
					racingController.abort(
						new DOMException("request cancelled before 503", "AbortError")
					);
					return Response.json({ error: "unavailable" }, { status: 503 });
				},
			}),
			racingController.signal
		);
		expect(abortWinsHttpFailure).toEqual([
			{
				outcome: {
					reason: "request cancelled before 503",
					status: "aborted",
				},
				type: "terminal",
			},
		]);

		const controller = new AbortController();
		const sdk = createProviderCollection();
		sdk.register(
			createDeepSeekProvider({
				fetch: async (_input, init) =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(streamController) {
								streamController.enqueue(
									new TextEncoder().encode(
										'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
									)
								);
								init?.signal?.addEventListener(
									"abort",
									() => streamController.error(init.signal?.reason),
									{ once: true }
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } }
					),
			})
		);
		await sdk.setCredential("deepseek", {
			apiKey: "terminal-test-secret",
			kind: "api-key",
		});
		const stream = sdk.chat({
			messages: [{ content: [{ text: "hello", type: "text" }], role: "user" }],
			modelId: "deepseek-chat",
			providerId: "deepseek",
			signal: controller.signal,
		});
		const iterator = stream[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({
			done: false,
			value: { delta: "partial", type: "text-delta" },
		});
		controller.abort(new DOMException("DeepSeek chat cancelled", "AbortError"));
		const terminalEvent = await iterator.next();
		expect(terminalEvent).toEqual({
			done: false,
			value: {
				outcome: { reason: "DeepSeek chat cancelled", status: "aborted" },
				type: "terminal",
			},
		});
		expect(
			terminalEvent.done ? "" : JSON.stringify(terminalEvent.value)
		).not.toContain("terminal-test-secret");
	});

	test("OpenRouter discovery failures and cancellation keep known models while availability remains auth-only", async () => {
		let mode: "initial" | "failure" | "cancel" = "initial";
		const cancellationFetchStarted = Promise.withResolvers<void>();
		const cancellationFetch = Promise.withResolvers<Response>();
		let discoveryRequests = 0;
		const sdk = createProviderCollection();
		sdk.register(
			createOpenRouterProvider({
				fetch: async (_input, init) => {
					discoveryRequests += 1;
					if (mode === "failure") {
						return Response.json({ error: "offline" }, { status: 503 });
					}
					if (mode === "cancel") {
						cancellationFetchStarted.resolve();
						const signal = init?.signal;
						if (!signal) {
							throw new Error("discovery did not receive cancellation");
						}
						signal.addEventListener(
							"abort",
							() =>
								cancellationFetch.reject(
									signal.reason ?? new DOMException("Aborted", "AbortError")
								),
							{ once: true }
						);
						if (signal.aborted) {
							throw signal.reason;
						}
						return cancellationFetch.promise;
					}
					return Response.json({ data: [{ id: "stable/model" }] });
				},
			})
		);
		await sdk.setCredential("openrouter", {
			apiKey: "configured-openrouter-key",
			kind: "api-key",
		});
		const knownModels = await sdk.refreshModels("openrouter");
		expect(knownModels.map((model) => model.modelId)).toEqual(["stable/model"]);
		expect(await sdk.getAvailable()).toEqual(knownModels);

		mode = "failure";
		await expect(sdk.refreshModels("openrouter")).rejects.toThrow(
			"OpenRouter model discovery failed (503)."
		);
		expect(sdk.getModels()).toEqual(knownModels);
		expect(await sdk.getAvailable()).toEqual(knownModels);

		mode = "cancel";
		const controller = new AbortController();
		const cancelledRefresh = sdk.refreshModels("openrouter", {
			signal: controller.signal,
		});
		await cancellationFetchStarted.promise;
		controller.abort(new DOMException("refresh cancelled", "AbortError"));
		await expect(cancelledRefresh).rejects.toThrow("refresh cancelled");
		expect(discoveryRequests).toBe(3);
		expect(sdk.getModels()).toEqual(knownModels);
		expect(await sdk.getAvailable()).toEqual(knownModels);
	});
});
