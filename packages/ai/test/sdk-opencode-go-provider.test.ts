import { describe, expect, test } from "bun:test";
import {
	type ChatEvent,
	type ChatRequest,
	createAnthropicProvider,
	createOpenAIProvider,
	createOpenCodeGoProvider,
	createProviderCollection,
	type OpenCodeGoFetch,
	type ProviderCollection,
	type ThinkingLevel,
} from "@wincode/ai";

const sseResponse = (events: readonly Readonly<Record<string, unknown>>[]) =>
	new Response(
		events
			.map(
				(event) =>
					`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
			)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);

const collect = async (
	sdk: ProviderCollection,
	modelId: string,
	reasoningEffort?: ThinkingLevel,
	headerOptions: Pick<ChatRequest, "headers" | "transformHeaders"> = {}
): Promise<ChatEvent[]> => {
	const events: ChatEvent[] = [];
	for await (const event of sdk.chat({
		messages: [
			{ content: [{ text: "Say hello", type: "text" }], role: "user" },
		],
		modelId,
		providerId: "opencode-go",
		...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		...headerOptions,
	})) {
		events.push(event);
	}
	return events;
};

describe("public OpenCode Go SDK provider", () => {
	test("each provider model selects its OpenCode Go protocol route and credential", async () => {
		const requests: {
			body: Record<string, unknown>;
			headers: Headers;
			url: string;
		}[] = [];
		let responses = 0;
		const fetch: OpenCodeGoFetch = async (url, init) => {
			requests.push({
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				headers: new Headers(init?.headers),
				url: String(url),
			});
			responses += 1;
			if (responses === 1 || responses === 7) {
				return sseResponse([
					{
						type: "response.reasoning_summary_text.delta",
						delta: "Reasoning route",
					},
					{
						type: "response.output_text.delta",
						delta: "Responses route",
					},
					{
						type: "response.completed",
						response: {
							output: [],
							usage: { input_tokens: 3, output_tokens: 2 },
						},
					},
				]);
			}
			if (responses === 2 || responses === 4) {
				return sseResponse([
					{ type: "message_start", message: { usage: { input_tokens: 4 } } },
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Messages route" },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", usage: { output_tokens: 2 } },
					{ type: "message_stop" },
				]);
			}
			return sseResponse([
				{
					type: "chat.completion.chunk",
					choices: [
						{ delta: { content: "Compatible route" }, finish_reason: null },
					],
				},
				{
					type: "chat.completion.chunk",
					choices: [{ delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
				},
			]);
		};
		const sdk = createProviderCollection();
		sdk.register(createOpenAIProvider({ fetch: async () => new Response() }));
		sdk.register(
			createAnthropicProvider({ fetch: async () => new Response() })
		);
		const provider = createOpenCodeGoProvider({ fetch });
		sdk.register(provider);
		await sdk.setCredential("openai", {
			apiKey: "openai-secret",
			kind: "api-key",
		});
		await sdk.setCredential("anthropic", {
			apiKey: "anthropic-secret",
			kind: "api-key",
		});
		await sdk.setCredential("opencode-go", {
			apiKey: "opencode-go-secret",
			kind: "api-key",
		});

		const modelIds = sdk
			.getModels()
			.map((model) => `${model.providerId}/${model.modelId}`);
		const responsesEvents = await collect(sdk, "gpt-5.6-luna", "high");
		const messagesEvents = await collect(sdk, "qwen3.8-max", "xhigh");
		const compatibleEvents = await collect(sdk, "deepseek-v4.1-flash", "high");
		await collect(sdk, "qwen3.8-max", "minimal");
		await collect(sdk, "gpt-5.6-luna", "off");
		await collect(sdk, "qwen3.8-max", "off");
		await collect(sdk, "gpt-5.6-luna", undefined, {
			transformHeaders: (headers) => {
				expect(headers.authorization).toBe("Bearer opencode-go-secret");
				expect(headers["x-opencode-session"]).toBeTruthy();
				return {
					"x-opencode-session": null,
					authorization: "Bearer trusted-gateway-override",
				};
			},
		});

		expect(modelIds).toContain("openai/gpt-5.6");
		expect(modelIds).toContain("anthropic/claude-sonnet-4-6");
		expect(modelIds).toContain("opencode-go/gpt-5.6-luna");
		expect(requests.map(({ url }) => url)).toEqual([
			"https://opencode.ai/zen/go/v1/responses",
			"https://opencode.ai/zen/go/v1/messages",
			"https://opencode.ai/zen/go/v1/chat/completions",
			"https://opencode.ai/zen/go/v1/messages",
			"https://opencode.ai/zen/go/v1/responses",
			"https://opencode.ai/zen/go/v1/messages",
			"https://opencode.ai/zen/go/v1/responses",
		]);
		const sessionId = requests[0]?.headers.get("x-opencode-session") ?? null;
		expect(sessionId).toBeTruthy();
		expect(
			requests
				.slice(0, 6)
				.map(({ headers }) => headers.get("x-opencode-session"))
		).toEqual(requests.slice(0, 6).map(() => sessionId));
		expect(requests[6]?.headers.get("authorization")).toBe(
			"Bearer trusted-gateway-override"
		);
		expect(requests[6]?.headers.has("x-opencode-session")).toBe(false);
		expect(
			provider.models.find(({ modelId }) => modelId === "qwen3.8-max")
				?.reasoningEfforts
		).toContain("off");
		expect(
			provider.models.find(({ modelId }) => modelId === "qwen3.8-max")
				?.reasoningEfforts
		).not.toContain("minimal");
		expect(requests[3]?.body).not.toHaveProperty("output_config");
		expect(requests[4]?.body).not.toHaveProperty("reasoning");
		expect(requests[5]?.body).not.toHaveProperty("thinking");
		expect(requests[5]?.body).not.toHaveProperty("output_config");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer opencode-go-secret"
		);
		expect(requests[0]?.body).toMatchObject({
			model: "gpt-5.6-luna",
			reasoning: { effort: "high" },
			stream: true,
		});
		expect(requests[1]?.headers.get("x-api-key")).toBe("opencode-go-secret");
		expect(requests[1]?.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(requests[1]?.body).toMatchObject({
			model: "qwen3.8-max",
			output_config: { effort: "xhigh" },
			stream: true,
		});
		expect(requests[2]?.headers.get("authorization")).toBe(
			"Bearer opencode-go-secret"
		);
		expect(requests[2]?.body).toMatchObject({
			model: "deepseek-v4.1-flash",
			reasoning_effort: "high",
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(responsesEvents).toContainEqual({
			delta: "Reasoning route",
			type: "reasoning-delta",
		});
		expect(responsesEvents).toContainEqual({
			delta: "Responses route",
			type: "text-delta",
		});
		expect(responsesEvents).toContainEqual({
			type: "usage",
			usage: { inputTokens: 3, outputTokens: 2 },
		});
		expect(messagesEvents).toContainEqual({
			type: "usage",
			usage: { inputTokens: 4, outputTokens: 2 },
		});
		expect(compatibleEvents).toContainEqual({
			type: "usage",
			usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
		});
		expect(messagesEvents).toContainEqual({
			delta: "Messages route",
			type: "text-delta",
		});
		expect(compatibleEvents).toContainEqual({
			delta: "Compatible route",
			type: "text-delta",
		});
		expect(JSON.stringify(requests)).not.toContain("openai-secret");
		expect(JSON.stringify(requests)).not.toContain("anthropic-secret");
		expect(provider.models.map(({ protocolId }) => protocolId)).toContain(
			"openai-responses"
		);
		expect(provider.models.map(({ protocolId }) => protocolId)).toContain(
			"anthropic"
		);
		expect(provider.models.map(({ protocolId }) => protocolId)).toContain(
			"openai-compatible"
		);
	});

	test("grok-4.6 avoids OpenCode Go's rejecting Chat Completions protocol", async () => {
		const requests: { body: Record<string, unknown>; url: string }[] = [];
		const sdk = createProviderCollection();
		const provider = createOpenCodeGoProvider({
			fetch: async (url, init) => {
				requests.push({
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
					url: String(url),
				});
				return sseResponse([
					{
						type: "response.completed",
						response: {
							output: [],
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
				]);
			},
		});
		sdk.register(provider);
		await sdk.setCredential("opencode-go", {
			apiKey: "opencode-go-secret",
			kind: "api-key",
		});

		expect(provider.models).toContainEqual(
			expect.objectContaining({
				modelId: "grok-4.6",
				protocolId: "openai-responses",
				providerId: "opencode-go",
			})
		);
		await collect(sdk, "grok-4.6");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(requests[0]?.body).toMatchObject({
			model: "grok-4.6",
			stream: true,
		});
	});

	test("gpt-6-luna is selectable through OpenCode Go's Responses route", async () => {
		const requests: { body: Record<string, unknown>; url: string }[] = [];
		const sdk = createProviderCollection();
		const provider = createOpenCodeGoProvider({
			fetch: async (url, init) => {
				requests.push({
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
					url: String(url),
				});
				return sseResponse([
					{
						type: "response.completed",
						response: {
							output: [],
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					},
				]);
			},
		});
		sdk.register(provider);
		await sdk.setCredential("opencode-go", {
			apiKey: "opencode-go-secret",
			kind: "api-key",
		});

		expect(provider.models).toContainEqual(
			expect.objectContaining({
				modelId: "gpt-6-luna",
				protocolId: "openai-responses",
				providerId: "opencode-go",
			})
		);
		await collect(sdk, "gpt-6-luna");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(requests[0]?.body).toMatchObject({
			model: "gpt-6-luna",
			stream: true,
		});
	});

	test("Responses tool continuation and results are replayed once by the selected OpenCode Go model", async () => {
		const requests: Record<string, unknown>[] = [];
		let call = 0;
		const sdk = createProviderCollection();
		sdk.register(
			createOpenCodeGoProvider({
				fetch: async (_url, init) => {
					requests.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>
					);
					call += 1;
					if (call === 1) {
						return sseResponse([
							{
								type: "response.output_item.done",
								item: {
									arguments: '{"city":"Paris"}',
									call_id: "call-weather",
									name: "weather",
									type: "function_call",
								},
							},
							{
								type: "response.completed",
								response: {
									output: [
										{
											arguments: '{"city":"Paris"}',
											call_id: "call-weather",
											id: "fc-weather",
											name: "weather",
											type: "function_call",
										},
									],
									usage: { input_tokens: 8, output_tokens: 3 },
								},
							},
						]);
					}
					return sseResponse([
						{ type: "response.output_text.delta", delta: "Sunny." },
						{
							type: "response.completed",
							response: {
								output: [],
								usage: { input_tokens: 10, output_tokens: 2 },
							},
						},
					]);
				},
			})
		);
		await sdk.setCredential("opencode-go", {
			apiKey: "opencode-session-key",
			kind: "api-key",
		});
		const firstEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [{ text: "Weather in Paris?", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6-luna",
			providerId: "opencode-go",
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
			firstEvents.push(event);
		}
		const firstTerminal = firstEvents.at(-1);
		const continuation =
			firstTerminal?.type === "terminal" &&
			firstTerminal.outcome.status === "success"
				? firstTerminal.outcome.continuation
				: undefined;
		const secondEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [
						{ text: "Checking the weather.", type: "text" },
						{
							input: { city: "Paris" },
							toolCallId: "call-weather",
							toolName: "weather",
							type: "tool-call",
						},
					],
					continuation,
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
			modelId: "gpt-5.6-luna",
			providerId: "opencode-go",
		})) {
			secondEvents.push(event);
		}

		expect(firstEvents).toContainEqual({
			input: { city: "Paris" },
			toolCallId: "call-weather",
			toolName: "weather",
			type: "tool-call",
		});
		expect(requests[1]?.input).toEqual([
			{
				arguments: '{"city":"Paris"}',
				call_id: "call-weather",
				id: "fc-weather",
				name: "weather",
				type: "function_call",
			},
			{
				call_id: "call-weather",
				output: '{"temperature":20}',
				type: "function_call_output",
			},
		]);
		expect(secondEvents.at(-1)).toEqual({
			outcome: {
				completion: { kind: "completed" },
				continuation: [],
				status: "success",
			},
			type: "terminal",
		});
	});

	test("authentication, provider, network, and caller abort remain separate terminal outcomes", async () => {
		const rejection = createOpenCodeGoProvider({
			fetch: async () =>
				Response.json({ error: { message: "invalid key" } }, { status: 401 }),
		});
		const sdk = createProviderCollection();
		sdk.register(rejection);
		await sdk.setCredential("opencode-go", { apiKey: "bad", kind: "api-key" });
		const authEvents = await collect(sdk, "grok-4.6");
		expect(authEvents.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "authentication", providerId: "opencode-go" },
				status: "failure",
			},
			type: "terminal",
		});

		const providerFailureSdk = createProviderCollection();
		providerFailureSdk.register(
			createOpenCodeGoProvider({
				fetch: async () =>
					Response.json(
						{ error: { message: "upstream failed" } },
						{ status: 500 }
					),
			})
		);
		await providerFailureSdk.setCredential("opencode-go", {
			apiKey: "valid-shape",
			kind: "api-key",
		});
		const providerEvents = await collect(providerFailureSdk, "grok-4.6");
		expect(providerEvents.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "provider", providerId: "opencode-go" },
				status: "failure",
			},
			type: "terminal",
		});

		const transport = createOpenCodeGoProvider({
			fetch: async () => {
				throw new Error("offline");
			},
		});
		const transportSdk = createProviderCollection();
		transportSdk.register(transport);
		await transportSdk.setCredential("opencode-go", {
			apiKey: "valid-shape",
			kind: "api-key",
		});
		const transportEvents = await collect(transportSdk, "grok-4.6");
		expect(transportEvents.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "transport", providerId: "opencode-go" },
				status: "failure",
			},
			type: "terminal",
		});

		const aborted = new AbortController();
		aborted.abort(new DOMException("caller stopped", "AbortError"));
		const abortEvents: ChatEvent[] = [];
		for await (const event of transportSdk.chat({
			messages: [],
			modelId: "grok-4.6",
			providerId: "opencode-go",
			signal: aborted.signal,
		})) {
			abortEvents.push(event);
		}
		expect(abortEvents.at(-1)).toEqual({
			outcome: { reason: "caller stopped", status: "aborted" },
			type: "terminal",
		});
	});
});
