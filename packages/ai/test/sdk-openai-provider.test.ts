import { describe, expect, test } from "bun:test";
import {
	type ChatEvent,
	createOpenAIProvider,
	createProviderCollection,
	type OpenAIProvider,
} from "@wincode/ai";
import { createInMemoryCredentialStore } from "./support/credential-store.ts";

const openAIResponsePromptCache = {
	explicit: { retentionTiers: ["short"] },
	protocols: {
		"openai-responses": {
			breakpoints: true,
			eligibility: { minimumInputTokens: 1024 },
			promptCacheKey: true,
			retention: {
				field: "prompt_cache_options.ttl",
				values: { short: "30m" },
			},
		},
	},
} as const;

const sseResponse = (events: readonly Readonly<Record<string, unknown>>[]) =>
	new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);

describe("public OpenAI SDK provider", () => {
	test("rejects unsupported protocol mappings before a model becomes selectable", () => {
		expect(() =>
			createOpenAIProvider({
				models: [
					{
						modelId: "gpt-invalid-protocol",
						protocolId: "openai-respones",
						providerId: "openai",
					},
				],
			})
		).toThrow("OpenAI provider models must use a supported protocol ID.");
	});

	test("OpenAI Responses sends a model-declared minimal reasoning effort", async () => {
		const requests: Record<string, unknown>[] = [];
		const sdk = createProviderCollection();
		sdk.register(
			createOpenAIProvider({
				models: [
					{
						modelId: "custom-minimal-model",
						protocolId: "openai-responses",
						providerId: "openai",
						reasoningEfforts: ["minimal"],
					},
				],
				fetch: async (_input, init) => {
					requests.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>
					);
					return sseResponse([
						{
							type: "response.completed",
							response: {
								output: [],
								usage: {
									input_tokens: 1,
									output_tokens: 1,
									total_tokens: 2,
								},
							},
						},
					]);
				},
			})
		);
		await sdk.setCredential("openai", {
			kind: "api-key",
			apiKey: "openai-test-key",
		});

		for await (const _event of sdk.chat({
			messages: [{ content: [{ text: "Hi", type: "text" }], role: "user" }],
			modelId: "custom-minimal-model",
			providerId: "openai",
			reasoningEffort: "minimal",
		})) {
			// Consume the fake stream to inspect the serialized request.
		}

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			model: "custom-minimal-model",
			reasoning: { effort: "minimal" },
		});
	});

	test("API-key consumers retain Responses multimodal, tool, cache, usage, and continuation behavior", async () => {
		const continuation = [
			{ id: "rs_private", type: "reasoning" },
			{
				arguments: '{"city":"Paris"}',
				call_id: "call-weather",
				name: "weather",
				type: "function_call",
			},
		];
		const requests: {
			body: Record<string, unknown>;
			headers: Headers;
			url: string;
		}[] = [];
		const sdk = createProviderCollection();
		sdk.register(
			createOpenAIProvider({
				models: [
					{
						modelId: "gpt-5.6",
						promptCache: openAIResponsePromptCache,
						promptCacheRetentionTiers: ["short"],
						protocolId: "openai-responses",
						providerId: "openai",
						reasoningEfforts: ["high"],
					},
				],
				fetch: async (input, init) => {
					requests.push({
						body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						headers: new Headers(init?.headers),
						url: String(input),
					});
					return sseResponse([
						{ type: "response.output_text.delta", delta: "Forecast" },
						{
							type: "response.reasoning_summary_text.delta",
							delta: "Comparing the conditions",
						},
						{
							type: "response.function_call_arguments.done",
							call_id: "call-weather",
							name: "weather",
							arguments: '{"city":"Paris"}',
						},
						{
							type: "response.completed",
							response: {
								output: continuation,
								usage: {
									input_tokens: 20,
									output_tokens: 3,
									total_tokens: 23,
									input_tokens_details: { cached_tokens: 6 },
									output_tokens_details: { reasoning_tokens: 2 },
								},
							},
						},
					]);
				},
			})
		);
		await sdk.setCredential("openai", {
			kind: "api-key",
			apiKey: "openai-test-key",
		});
		expect(sdk.getModel("openai", "gpt-5.6")).toMatchObject({
			modelId: "gpt-5.6",
			promptCache: openAIResponsePromptCache,
			promptCacheRetentionTiers: ["short"],
			protocolId: "openai-responses",
			providerId: "openai",
			reasoningEfforts: ["high"],
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "short",
			reasoningEffort: "high",
			messages: [
				{
					content: [
						{ text: "Describe these", type: "text" },
						{
							data: "aW1hZ2U=",
							mediaType: "image/png",
							type: "image",
						},
						{
							data: "dGV4dA==",
							mediaType: "text/plain",
							type: "file",
						},
					],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			promptCacheKey: "wincode-session:consumer-test",
			providerId: "openai",
			system: "Be concise.",
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

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer openai-test-key"
		);
		expect(requests[0]?.headers.get("content-type")).toBe("application/json");
		const body = requests[0]?.body;
		expect(body).toMatchObject({
			model: "gpt-5.6",
			reasoning: { effort: "high" },
			stream: true,
			prompt_cache_key: "wincode-session:consumer-test",
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
			tools: [
				{
					type: "function",
					name: "weather",
					description: "Get a forecast.",
					parameters: {
						properties: { city: { type: "string" } },
						required: ["city"],
						type: "object",
					},
				},
			],
		});
		const input = body?.input as Record<string, unknown>[];
		expect(input[0]).toEqual({
			content: [
				{
					prompt_cache_breakpoint: { mode: "explicit" },
					text: "Be concise.",
					type: "input_text",
				},
			],
			role: "developer",
			type: "message",
		});
		expect(input[1]).toEqual({
			content: [
				{ text: "Describe these", type: "input_text" },
				{
					image_url: "data:image/png;base64,aW1hZ2U=",
					type: "input_image",
				},
				{
					file_data: "data:text/plain;base64,dGV4dA==",
					filename: "attachment",
					type: "input_file",
				},
			],
			role: "user",
			type: "message",
		});
		expect(events).toEqual([
			{ delta: "Forecast", type: "text-delta" },
			{
				delta: "Comparing the conditions",
				type: "reasoning-delta",
			},
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
					outputTokens: 3,
					cacheReadTokens: 6,
					reasoningTokens: 2,
					totalTokens: 23,
				},
			},
			{ outcome: { continuation, status: "success" }, type: "terminal" },
		]);
		expect(JSON.stringify(events)).not.toContain("openai-test-key");
		const firstTerminal = events.at(-1);
		const continuationForNext =
			firstTerminal?.type === "terminal" &&
			firstTerminal.outcome.status === "success"
				? firstTerminal.outcome.continuation
				: undefined;

		const nextEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [
						{ text: "Forecast", type: "text" },
						{
							input: { city: "Paris" },
							toolCallId: "call-weather",
							toolName: "weather",
							type: "tool-call",
						},
					],
					continuation: continuationForNext,
					role: "assistant",
				},
				{
					content: [
						{
							output: { temperature: 20 },
							toolCallId: "call-weather",
							toolName: "weather",
							type: "tool-result",
						},
					],
					role: "tool",
				},
			],
			modelId: "gpt-5.6",
			providerId: "openai",
		})) {
			nextEvents.push(event);
		}
		expect(requests).toHaveLength(2);
		expect(requests[1]?.body.input).toEqual([
			...continuation,
			{
				call_id: "call-weather",
				output: '{"temperature":20}',
				type: "function_call_output",
			},
		]);
		expect(nextEvents.at(-1)).toEqual({
			outcome: { continuation, status: "success" },
			type: "terminal",
		});
		for await (const _event of sdk.chat({
			messages: [
				{
					content: [{ text: "Unsupported effort?", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			providerId: "openai",
			reasoningEffort: "max",
		})) {
			// Consume the fake stream to inspect the serialized request.
		}
		expect(requests[2]?.body).not.toHaveProperty("reasoning");
	});

	test("OpenAI-compatible Chat Completions models keep their route and stream contract", async () => {
		const requests: {
			body: Record<string, unknown>;
			headers: Headers;
			url: string;
		}[] = [];
		const sdk = createProviderCollection();
		sdk.register(
			createOpenAIProvider({
				fetch: async (input, init) => {
					requests.push({
						body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						headers: new Headers(init?.headers),
						url: String(input),
					});
					return new Response(
						[
							'data: {"choices":[{"delta":{"content":"The forecast is sunny."}}]}\n\n',
							'data: {"choices":[{"delta":{"reasoning_content":"Cloud cover is low."}}]}\n\n',
							'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-next","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\n\n',
							'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
							"data: [DONE]\n\n",
						].join(""),
						{ headers: { "content-type": "text/event-stream" } }
					);
				},
				models: [
					{
						modelId: "compatible-chat-model",
						protocolId: "openai-chat",
						providerId: "openai",
						reasoningEfforts: ["high"],
					},
				],
			})
		);
		await sdk.setCredential("openai", {
			kind: "api-key",
			apiKey: "chat-route-key",
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [{ text: "Weather?", type: "text" }],
					role: "user",
				},
			],
			modelId: "compatible-chat-model",
			providerId: "openai",
			reasoningEffort: "high",
			tools: [
				{
					name: "weather",
					inputSchema: {
						properties: { city: { type: "string" } },
						type: "object",
					},
				},
			],
		})) {
			events.push(event);
		}

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer chat-route-key"
		);
		expect(requests[0]?.body).toMatchObject({
			model: "compatible-chat-model",
			reasoning_effort: "high",
			stream: true,
			stream_options: { include_usage: true },
			messages: [{ role: "user", content: "Weather?" }],
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
		for await (const _event of sdk.chat({
			messages: [
				{
					content: [{ text: "Unsupported effort?", type: "text" }],
					role: "user",
				},
			],
			modelId: "compatible-chat-model",
			providerId: "openai",
			reasoningEffort: "max",
		})) {
			// Consume the fake stream to inspect the serialized request.
		}
		expect(requests[1]?.body).not.toHaveProperty("reasoning_effort");
		expect(events).toEqual([
			{ delta: "The forecast is sunny.", type: "text-delta" },
			{ delta: "Cloud cover is low.", type: "reasoning-delta" },
			{
				input: { city: "Paris" },
				toolCallId: "call-next",
				toolName: "weather",
				type: "tool-call",
			},
			{
				type: "usage",
				usage: {
					inputTokens: 12,
					outputTokens: 5,
					cacheReadTokens: 3,
					reasoningTokens: 2,
					totalTokens: 17,
				},
			},
			{ outcome: { status: "success" }, type: "terminal" },
		]);
	});

	test("chat succeeds when unsupported Responses cache options trigger an uncached retry", async () => {
		const bodies: Record<string, unknown>[] = [];
		let attempts = 0;
		const sdk = createProviderCollection();
		sdk.register(
			createOpenAIProvider({
				fetch: async (_input, init) => {
					attempts += 1;
					const body = JSON.parse(String(init?.body)) as Record<
						string,
						unknown
					>;
					bodies.push(body);
					if (
						Object.hasOwn(body, "prompt_cache_key") ||
						Object.hasOwn(body, "prompt_cache_options")
					) {
						return Response.json(
							{ error: { message: "prompt_cache_options is not supported" } },
							{ status: 400 }
						);
					}
					return sseResponse([
						{
							type: "response.completed",
							response: {
								output: [],
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						},
					]);
				},
			})
		);
		await sdk.setCredential("openai", {
			kind: "api-key",
			apiKey: "cache-key",
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "short",
			messages: [
				{ content: [{ text: "cached prompt", type: "text" }], role: "user" },
			],
			modelId: "gpt-5.6",
			promptCacheKey: "wincode-session:cache-fallback",
			providerId: "openai",
			system: "Be concise.",
		})) {
			events.push(event);
		}

		expect(attempts).toBe(2);
		expect(bodies[0]?.prompt_cache_key).toBe("wincode-session:cache-fallback");
		expect(bodies[0]?.prompt_cache_options).toEqual({
			mode: "explicit",
			ttl: "30m",
		});
		expect(bodies[1]).not.toHaveProperty("prompt_cache_key");
		expect(bodies[1]).not.toHaveProperty("prompt_cache_options");
		expect(events.at(-1)).toEqual({
			outcome: { continuation: [], status: "success" },
			type: "terminal",
		});
	});

	test("OpenAI OAuth defaults are finalized before collection overrides reach dispatch", async () => {
		const requests: {
			body: Record<string, unknown>;
			headers: Headers;
			url: string;
		}[] = [];
		const provider = createOpenAIProvider({
			fetch: async (input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				requests.push({
					body,
					headers: new Headers(init?.headers),
					url: String(input),
				});
				if (body.store !== false) {
					return Response.json(
						{ detail: "Store must be set to false" },
						{ status: 400 }
					);
				}
				return sseResponse([
					{
						type: "response.completed",
						response: {
							output: [],
							usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
						},
					},
				]);
			},
		});
		const sdk = createProviderCollection();
		sdk.register(provider);
		await sdk.setCredential("openai", {
			accessToken: "oauth-test-access",
			accountId: "acct-test",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			kind: "oauth-session",
			refreshToken: "oauth-test-refresh",
			updatedAt: new Date().toISOString(),
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [{ content: [{ text: "hello", type: "text" }], role: "user" }],
			modelId: "gpt-5.6",
			providerId: "openai",
			transformHeaders: (headers) => {
				expect(headers["chatgpt-account-id"]).toBe("acct-test");
				return {
					"chatgpt-account-id": null,
					authorization: "Bearer trusted-gateway-override",
				};
			},
		})) {
			events.push(event);
		}

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://chatgpt.com/backend-api/codex/responses"
		);
		expect(requests[0]?.body.store).toBe(false);
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer trusted-gateway-override"
		);
		expect(requests[0]?.headers.has("chatgpt-account-id")).toBe(false);
		expect(requests[0]?.headers.get("openai-beta")).toBe(
			"responses=experimental"
		);
		expect(events.at(-1)).toMatchObject({
			outcome: { status: "success" },
			type: "terminal",
		});
	});

	test("browser OAuth credentials refresh once through app storage without exposing refresh tokens", async () => {
		const oldRefreshToken = "oauth-refresh-secret";
		const newRefreshToken = "rotated-refresh-secret";
		const initialCredential = {
			accessToken: "oauth-old-access",
			accountId: "acct-test",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			kind: "oauth-session" as const,
			refreshToken: oldRefreshToken,
			updatedAt: new Date().toISOString(),
		};
		const storedCredentials = new Map<string, unknown>();
		const writes: unknown[] = [];
		let refreshCount = 0;
		let loginOptions: { openBrowser?: boolean } | undefined;
		const apiRequests: { headers: Headers; url: string }[] = [];
		const credentialStore = createInMemoryCredentialStore(
			storedCredentials,
			(_providerId, credential) => {
				writes.push(credential);
			}
		);
		const provider = createOpenAIProvider({
			fetch: async (input, init) => {
				const url = String(input);
				if (url.endsWith("/oauth/token")) {
					refreshCount += 1;
					expect(String(init?.body)).toContain(oldRefreshToken);
					return Response.json({
						access_token: "oauth-new-access",
						expires_in: 3600,
						refresh_token: newRefreshToken,
						token_type: "Bearer",
					});
				}
				apiRequests.push({ url, headers: new Headers(init?.headers) });
				return sseResponse([
					{
						type: "response.completed",
						response: {
							output: [],
							usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
						},
					},
				]);
			},
			login: async (options) => {
				loginOptions = options;
				return initialCredential;
			},
		});
		const sdk = createProviderCollection({ credentialStore });
		sdk.register(provider);
		const login = await sdk.login("openai", {
			methodId: "openai-browser",
			options: { openBrowser: false },
		});
		expect(login).toEqual({ status: "saved" });
		expect(loginOptions?.openBrowser).toBe(false);

		const chat = async () => {
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [
					{ content: [{ text: "hello", type: "text" }], role: "user" },
				],
				modelId: "gpt-5.6",
				providerId: "openai",
			})) {
				events.push(event);
			}
			return events;
		};
		const [firstEvents, secondEvents] = await Promise.all([chat(), chat()]);
		const stored = storedCredentials.get("openai");

		expect(refreshCount).toBe(1);
		expect(apiRequests).toHaveLength(2);
		expect(apiRequests[0]?.url).toBe(
			"https://chatgpt.com/backend-api/codex/responses"
		);
		expect(apiRequests[0]?.headers.get("authorization")).toBe(
			"Bearer oauth-new-access"
		);
		expect(apiRequests[0]?.headers.get("chatgpt-account-id")).toBe("acct-test");
		expect(stored).toMatchObject({
			accessToken: "oauth-new-access",
			accountId: "acct-test",
			refreshToken: newRefreshToken,
		});
		expect(writes).toHaveLength(2);
		for (const events of [firstEvents, secondEvents]) {
			expect(JSON.stringify(events)).not.toContain(oldRefreshToken);
			expect(JSON.stringify(events)).not.toContain(newRefreshToken);
			expect(events.at(-1)).toMatchObject({
				outcome: { status: "success" },
				type: "terminal",
			});
		}
	});

	test("caller cancellation does not discard a started OAuth refresh or rotation", async () => {
		const abortController = new AbortController();
		const refreshStarted = Promise.withResolvers<void>();
		const finishRefresh = Promise.withResolvers<Response>();
		const storedCredentials = new Map<string, unknown>();
		let refreshSignal: AbortSignal | undefined;
		const credentialStore = createInMemoryCredentialStore(storedCredentials);
		const credential = {
			accessToken: "expired-access",
			accountId: "acct-test",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			kind: "oauth-session",
			refreshToken: "cancelled-refresh-secret",
			updatedAt: new Date().toISOString(),
		};
		const provider = createOpenAIProvider({
			fetch: async (_input, init) => {
				refreshSignal = init?.signal ?? undefined;
				refreshStarted.resolve();
				return finishRefresh.promise;
			},
		});
		const sdk = createProviderCollection({ credentialStore });
		sdk.register(provider);
		await sdk.setCredential("openai", credential);
		const eventsPromise = (async () => {
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [],
				modelId: "gpt-5.6",
				providerId: "openai",
				signal: abortController.signal,
			})) {
				events.push(event);
			}
			return events;
		})();

		try {
			await refreshStarted.promise;
			expect(refreshSignal).toBeInstanceOf(AbortSignal);
			expect(refreshSignal).not.toBe(abortController.signal);
			abortController.abort(
				new DOMException("refresh cancelled", "AbortError")
			);
			const events = await eventsPromise;
			expect(events.at(-1)).toMatchObject({
				outcome: { reason: "refresh cancelled", status: "aborted" },
				type: "terminal",
			});
			expect(JSON.stringify(events)).not.toContain("cancelled-refresh-secret");

			finishRefresh.resolve(
				Response.json({
					access_token: "rotated-access",
					expires_in: 3600,
					refresh_token: "rotated-refresh-secret",
					token_type: "Bearer",
				})
			);
			const auth = await sdk.getAuth("openai");
			expect(auth).toMatchObject({
				authorization: {
					accessToken: "rotated-access",
					accountId: "acct-test",
					kind: "oauth",
				},
			});
			expect(storedCredentials.get("openai")).toMatchObject({
				accessToken: "rotated-access",
				refreshToken: "rotated-refresh-secret",
			});
		} finally {
			finishRefresh.resolve(new Response(null, { status: 500 }));
			await sdk.close();
		}
	});

	test("missing auth, expired OAuth, provider refusal, network failure, and abort stay distinct", async () => {
		const collectTerminal = async (
			provider: OpenAIProvider,
			credential?: unknown,
			signal?: AbortSignal
		) => {
			const sdk = createProviderCollection();
			sdk.register(provider);
			if (credential !== undefined) {
				await sdk.setCredential("openai", credential);
			}
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [],
				modelId: "gpt-5.6",
				providerId: "openai",
				signal,
			})) {
				events.push(event);
			}
			return events.at(-1);
		};
		const apiKey = { kind: "api-key", apiKey: "test-key" };
		const expiredOAuthCredential = {
			accessToken: "expired-access",
			accountId: "acct-test",
			expiresAt: new Date(Date.now() - 1).toISOString(),
			kind: "oauth-session",
			refreshToken: "expired-refresh-secret",
			updatedAt: new Date().toISOString(),
		};
		const missing = await collectTerminal(createOpenAIProvider());
		const expiredOauth = await collectTerminal(
			createOpenAIProvider({
				fetch: async () => new Response("denied", { status: 400 }),
			}),
			expiredOAuthCredential
		);
		const expiredOAuthNetwork = await collectTerminal(
			createOpenAIProvider({
				fetch: async () => {
					throw new TypeError("token service unavailable");
				},
			}),
			expiredOAuthCredential
		);
		const rejected = await collectTerminal(
			createOpenAIProvider({
				fetch: async () => new Response("denied", { status: 401 }),
			}),
			apiKey
		);
		const providerFailure = await collectTerminal(
			createOpenAIProvider({
				fetch: async () => new Response("overloaded", { status: 503 }),
			}),
			apiKey
		);
		const networkFailure = await collectTerminal(
			createOpenAIProvider({
				fetch: async () => {
					throw new TypeError("connection reset");
				},
			}),
			apiKey
		);

		const abortController = new AbortController();
		const abortingProvider = createOpenAIProvider({
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(streamController) {
							streamController.enqueue(
								new TextEncoder().encode(
									`data: {"type":"response.output_text.delta","delta":"partial"}\n\n`
								)
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } }
				),
		});
		const abortSdk = createProviderCollection();
		abortSdk.register(abortingProvider);
		await abortSdk.setCredential("openai", apiKey);
		const abortEvents: ChatEvent[] = [];
		for await (const event of abortSdk.chat({
			messages: [],
			modelId: "gpt-5.6",
			providerId: "openai",
			signal: abortController.signal,
		})) {
			abortEvents.push(event);
			if (event.type === "text-delta") {
				abortController.abort(
					new DOMException("caller cancelled", "AbortError")
				);
			}
		}

		expect(missing).toMatchObject({
			outcome: { failure: { code: "authentication" }, status: "failure" },
			type: "terminal",
		});
		expect(expiredOauth).toMatchObject({
			outcome: { failure: { code: "authentication" }, status: "failure" },
			type: "terminal",
		});
		expect(JSON.stringify(expiredOauth)).not.toContain(
			"expired-refresh-secret"
		);
		expect(expiredOAuthNetwork).toMatchObject({
			outcome: { failure: { code: "transport" }, status: "failure" },
			type: "terminal",
		});
		expect(JSON.stringify(expiredOAuthNetwork)).not.toContain(
			"expired-refresh-secret"
		);
		expect(rejected).toMatchObject({
			outcome: { failure: { code: "authentication" }, status: "failure" },
			type: "terminal",
		});
		expect(providerFailure).toMatchObject({
			outcome: { failure: { code: "provider" }, status: "failure" },
			type: "terminal",
		});
		expect(networkFailure).toMatchObject({
			outcome: { failure: { code: "transport" }, status: "failure" },
			type: "terminal",
		});
		expect(abortEvents).toEqual([
			{ delta: "partial", type: "text-delta" },
			{
				outcome: { reason: "caller cancelled", status: "aborted" },
				type: "terminal",
			},
		]);
	});

	test("shared reasoning off serializes as native none for both OpenAI APIs", async () => {
		const requests: Record<string, unknown>[] = [];
		const sdk = createProviderCollection();
		sdk.register(
			createOpenAIProvider({
				models: [
					{
						modelId: "responses-off-model",
						protocolId: "openai-responses",
						providerId: "openai",
						reasoningEfforts: ["off"],
					},
					{
						modelId: "chat-off-model",
						protocolId: "openai-chat",
						providerId: "openai",
						reasoningEfforts: ["off"],
					},
				],
				fetch: async (input, init) => {
					requests.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>
					);
					return String(input).endsWith("/responses")
						? sseResponse([
								{
									type: "response.completed",
									response: {
										output: [],
										usage: { input_tokens: 1, output_tokens: 0 },
									},
								},
							])
						: sseResponse([
								{ choices: [{ delta: {}, finish_reason: "stop" }] },
							]);
				},
			})
		);
		await sdk.setCredential("openai", {
			kind: "api-key",
			apiKey: "off-reasoning-test-key",
		});

		for (const modelId of ["responses-off-model", "chat-off-model"]) {
			for await (const _event of sdk.chat({
				messages: [{ content: [{ text: "Hi", type: "text" }], role: "user" }],
				modelId,
				providerId: "openai",
				reasoningEffort: "off",
			})) {
				// Consume the stream to verify the public provider boundary.
			}
		}

		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ reasoning: { effort: "none" } });
		expect(requests[1]).toMatchObject({ reasoning_effort: "none" });
	});
});
