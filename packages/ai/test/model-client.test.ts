import { describe, expect, test } from "bun:test";
import { createModelClient, generateModelText } from "../src/model-client";
import { ModelProviderError } from "../src/model-client/errors";
import type {
	ModelClient,
	ModelPromptMessage,
	ModelStreamPart,
	ModelTextGenerationResult,
	ModelTool,
} from "../src/model-client/types";
import type { ModelProviderResolutionOptions } from "../src/model-provider-options";
import type { ModelAuthorization, ModelTarget } from "../src/model-target";
import { createModelTarget } from "../src/model-target";
import type { ConnectionProviderId } from "../src/models";
import { supportedChatModelIdSchema } from "../src/models";

type FetchMock = Readonly<{
	fetch: typeof globalThis.fetch;
	init: RequestInit | undefined;
	url: string;
}>;

const makeTarget = (
	providerId: ConnectionProviderId,
	modelId: string,
	authorization: ModelAuthorization = { apiKey: "test-key", kind: "api-key" },
	options: ModelProviderResolutionOptions = {}
): ModelTarget =>
	createModelTarget(
		{
			modelId: supportedChatModelIdSchema.parse(modelId),
			providerId,
		},
		authorization,
		options
	);

const sseResponse = (...chunks: string[]): Response =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } }
	);

const mockFetch = (response: Response): FetchMock => {
	let url = "";
	let init: RequestInit | undefined;
	const fetch = (async (
		input: Request | string | URL,
		options?: RequestInit
	) => {
		url = String(input);
		init = options;
		return response;
	}) as typeof globalThis.fetch;
	return {
		fetch,
		get init() {
			return init;
		},
		get url() {
			return url;
		},
	};
};

const responseBody = (mock: FetchMock) =>
	JSON.parse(String(mock.init?.body)) as Record<string, unknown>;

const collect = async (
	client: ModelClient,
	target: ModelTarget,
	messages: readonly ModelPromptMessage[] = [],
	options: {
		signal?: AbortSignal;
		system?: string;
		tools?: readonly ModelTool[];
	} = {}
): Promise<ModelStreamPart[]> => {
	const parts: ModelStreamPart[] = [];
	for await (const part of client.stream({
		messages,
		target,
		...options,
	})) {
		parts.push(part);
	}
	return parts;
};

const lookupTool: ModelTool = {
	description: "Find a record.",
	inputSchema: {
		properties: { query: { type: "string" } },
		required: ["query"],
		type: "object",
	},
	name: "lookup",
};

describe("native model client routes", () => {
	test("streams Responses text, reasoning, tool calls, and normalized usage", async () => {
		const wire = [
			": keep-alive\r\n\r\n",
			"event: response.output_text.delta\r\ndata: not-json\r\n\r\n",
			'event: response.output_text.delta\r\ndata: {"delta":"Hello"}\r\n\r\n',
			'event: response.reasoning_summary_text.delta\r\ndata: {"delta":"Checking"}\r\n\r\n',
			'event: response.output_item.done\r\ndata: {"item":{"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{\\"query\\":\\"x\\"}"}}\r\n\r\n',
			'event: response.completed\r\ndata: {"response":{"usage":{"input_tokens":11,"output_tokens":5,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}}\r\n\r\n',
		].join("");
		const mock = mockFetch(
			sseResponse(wire.slice(0, 29), wire.slice(29, 211), wire.slice(211))
		);
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("openai", "gpt-5.6-luna", undefined, {
			maxOutputTokens: 1200,
			variant: "high",
		});
		const parts = await collect(
			client,
			target,
			[
				{
					content: [
						{ text: "Read this", type: "text" },
						{
							data: "aGVsbG8=",
							mediaType: "image/png",
							type: "file",
						},
					],
					role: "user",
				},
			],
			{ system: "Be concise.", tools: [lookupTool] }
		);

		expect(mock.url).toBe("https://api.openai.com/v1/responses");
		expect(new Headers(mock.init?.headers).get("authorization")).toBe(
			"Bearer test-key"
		);
		const body = responseBody(mock);
		expect(body).toMatchObject({
			model: "gpt-5.6-luna",
			instructions: "Be concise.",
			max_output_tokens: 1200,
			reasoning: { effort: "high", summary: "detailed" },
			store: false,
		});
		expect(body.input).toEqual([
			{
				role: "user",
				type: "message",
				content: [
					{ type: "input_text", text: "Read this" },
					{
						type: "input_image",
						image_url: "data:image/png;base64,aGVsbG8=",
					},
				],
			},
		]);
		expect(body.tools).toEqual([
			{
				type: "function",
				name: "lookup",
				description: "Find a record.",
				parameters: lookupTool.inputSchema,
			},
		]);
		expect(parts).toEqual([
			{ delta: "Hello", type: "text-delta" },
			{ delta: "Checking", type: "reasoning-delta" },
			{
				input: { query: "x" },
				toolCallId: "call-1",
				toolName: "lookup",
				type: "tool-call",
			},
			{
				type: "finish",
				usage: {
					cacheReadTokens: 2,
					inputTokens: 11,
					outputTokens: 5,
					reasoningTokens: 1,
				},
			},
		]);
	});

	test("replays raw Responses output items when continuing a tool step", async () => {
		const continuation = [
			{
				encrypted_content: "signed-thought",
				id: "rs_1",
				summary: [],
				type: "reasoning",
			},
			{
				arguments: '{"query":"x"}',
				call_id: "call-1",
				id: "fc_1",
				name: "lookup",
				status: "completed",
				type: "function_call",
			},
		];
		const target = makeTarget("openai", "gpt-5.6-luna");
		const firstMock = mockFetch(
			sseResponse(
				'event: response.output_item.done\ndata: {"item":{"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{\\"query\\":\\"x\\"}"}}\n\n',
				`event: response.completed\ndata: ${JSON.stringify({
					response: { output: continuation },
				})}\n\n`
			)
		);
		const parts = await collect(
			createModelClient({ fetch: firstMock.fetch }),
			target,
			[],
			{ tools: [lookupTool] }
		);
		const finish = parts.at(-1);
		if (finish?.type !== "finish") {
			throw new Error("Expected Responses stream to finish.");
		}

		const resumedMock = mockFetch(
			sseResponse(
				`event: response.completed\ndata: ${JSON.stringify({
					response: { output: [] },
				})}\n\n`
			)
		);
		await collect(
			createModelClient({ fetch: resumedMock.fetch }),
			target,
			[
				{
					content: [
						{
							input: { query: "x" },
							toolCallId: "call-1",
							toolName: "lookup",
							type: "tool-call",
						},
					],
					continuation: finish.continuation,
					role: "assistant",
				},
				{
					content: [
						{
							output: { result: "found" },
							toolCallId: "call-1",
							toolName: "lookup",
							type: "tool-result",
						},
					],
					role: "tool",
				},
			],
			{ tools: [lookupTool] }
		);

		expect(finish.continuation).toEqual(continuation);
		expect(responseBody(resumedMock).input).toEqual([
			...continuation,
			{
				call_id: "call-1",
				output: '{"result":"found"}',
				type: "function_call_output",
			},
		]);
	});

	test("accepts a Responses incomplete event as a terminal result", async () => {
		const mock = mockFetch(
			sseResponse(
				'event: response.incomplete\ndata: {"response":{"status":"incomplete","output":[]}}\n\n'
			)
		);

		const parts = await collect(
			createModelClient({ fetch: mock.fetch }),
			makeTarget("openai", "gpt-5.6-luna")
		);

		expect(parts).toEqual([{ type: "finish", continuation: [] }]);
	});

	const incompleteProviderStreams = [
		{
			modelId: "gpt-5.6-luna",
			name: "OpenAI Responses",
			providerId: "openai",
			wire: 'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n',
		},
		{
			modelId: "claude-opus-4-5",
			name: "Anthropic Messages",
			providerId: "anthropic",
			wire: 'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
		},
		{
			modelId: "gemini-3.6-flash",
			name: "Google GenerateContent",
			providerId: "google",
			wire: 'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
		},
		{
			modelId: "grok-4.6",
			name: "OpenAI Chat Completions",
			providerId: "opencode-go",
			wire: 'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
		},
	] as const;
	for (const { modelId, name, providerId, wire } of incompleteProviderStreams) {
		test(`rejects truncated ${name} streams instead of reporting completion`, async () => {
			const mock = mockFetch(sseResponse(wire));
			await expect(
				collect(
					createModelClient({ fetch: mock.fetch }),
					makeTarget(providerId, modelId)
				)
			).rejects.toBeInstanceOf(ModelProviderError);
		});
	}

	test("uses the Codex OAuth Responses route and omits its rejected output cap", async () => {
		const mock = mockFetch(sseResponse("data: [DONE]\n\n"));
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget(
			"openai",
			"gpt-5.6-luna",
			{ accessToken: "oauth-token", accountId: "acct-123", kind: "oauth" },
			{ maxOutputTokens: 800, variant: "low" }
		);

		const parts = await collect(client, target);

		expect(mock.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		const headers = new Headers(mock.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer oauth-token");
		expect(headers.get("chatgpt-account-id")).toBe("acct-123");
		expect(headers.get("openai-beta")).toBe("responses=experimental");
		expect(headers.get("originator")).toBe("wincode");
		const body = responseBody(mock);
		expect(body.model).toBe("gpt-5.6-luna");
		expect(body.max_output_tokens).toBeUndefined();
		expect(parts).toEqual([{ type: "finish" }]);
	});

	test("maps Anthropic messages, documents, tools, thinking, and usage", async () => {
		const mock = mockFetch(
			sseResponse(
				'event: message_start\ndata: {"message":{"usage":{"input_tokens":18,"cache_read_input_tokens":3}}}\n\n',
				'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking"}}\n\n',
				'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}\n\n',
				'event: content_block_delta\ndata: {"index":0,"delta":{"type":"signature_delta","signature":"signed-thought"}}\n\n',
				'event: content_block_start\ndata: {"index":1,"content_block":{"type":"text","text":""}}\n\n',
				'event: content_block_delta\ndata: {"index":1,"delta":{"type":"text_delta","text":"!"}}\n\n',
				'event: content_block_start\ndata: {"index":2,"content_block":{"type":"tool_use","id":"tool-1","name":"lookup","input":{}}}\n\n',
				'event: content_block_delta\ndata: {"index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}\n\n',
				'event: content_block_stop\ndata: {"index":2}\n\n',
				'event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n',
				'event: message_stop\ndata: {"type":"message_stop"}\n\n'
			)
		);
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("anthropic", "claude-opus-4-5", undefined, {
			maxOutputTokens: 9000,
			variant: "high",
		});
		const parts = await collect(
			client,
			target,
			[
				{
					content: [
						{ text: "Find this", type: "text" },
						{
							data: "JVBERi0=",
							mediaType: "application/pdf",
							type: "file",
						},
					],
					role: "user",
				},
				{
					content: [
						{
							input: { query: "x" },
							toolCallId: "tool-1",
							toolName: "lookup",
							type: "tool-call",
						},
					],
					role: "assistant",
				},
				{
					content: [
						{
							output: { count: 1 },
							toolCallId: "tool-1",
							toolName: "lookup",
							type: "tool-result",
						},
					],
					role: "tool",
				},
			],
			{ tools: [lookupTool] }
		);

		expect(mock.url).toBe("https://api.anthropic.com/v1/messages");
		expect(new Headers(mock.init?.headers).get("x-api-key")).toBe("test-key");
		const body = responseBody(mock);
		expect(body).toMatchObject({
			model: "claude-opus-4-5",
			max_tokens: 9000,
			output_config: { effort: "high" },
			thinking: { type: "enabled", budget_tokens: 2250 },
			stream: true,
		});
		const requestMessages = body.messages as { content: unknown }[];
		expect(requestMessages[0]?.content).toEqual([
			{ type: "text", text: "Find this" },
			{
				type: "document",
				source: {
					type: "base64",
					media_type: "application/pdf",
					data: "JVBERi0=",
				},
			},
		]);
		expect(requestMessages[1]?.content).toEqual([
			{ type: "tool_use", id: "tool-1", name: "lookup", input: { query: "x" } },
		]);
		expect(requestMessages[2]?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content: JSON.stringify({ count: 1 }),
			},
		]);
		expect(parts.slice(0, -1)).toEqual([
			{ delta: "Plan", type: "reasoning-delta" },
			{ delta: "!", type: "text-delta" },
			{
				input: { query: "x" },
				toolCallId: "tool-1",
				toolName: "lookup",
				type: "tool-call",
			},
		]);
		const finish = parts.at(-1);
		expect(finish).toMatchObject({
			type: "finish",
			usage: { cacheReadTokens: 3, inputTokens: 18, outputTokens: 7 },
		});
		if (finish?.type !== "finish") {
			throw new Error("Expected Anthropic stream to finish.");
		}
		const resumedMock = mockFetch(
			sseResponse('event: message_stop\ndata: {"type":"message_stop"}\n\n')
		);
		await collect(createModelClient({ fetch: resumedMock.fetch }), target, [
			{ role: "assistant", content: [], continuation: finish.continuation },
		]);
		const resumedMessages = responseBody(resumedMock).messages as {
			content: unknown;
		}[];
		expect(resumedMessages[0]?.content).toEqual(finish.continuation);
		expect(resumedMessages[0]?.content).toContainEqual(
			expect.objectContaining({ signature: "signed-thought" })
		);
	});

	test("uses Google GenerateContent with thinking, files, functions, and thought deltas", async () => {
		const mock = mockFetch(
			sseResponse(
				'data: {"candidates":[{"content":{"parts":[{"text":"Think","thought":true,"thoughtSignature":"signed-google"},{"text":"Answer"},{"functionCall":{"name":"lookup","args":{"query":"x"}}}]}}]}\n\n',
				'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":6,"thoughtsTokenCount":2,"totalTokenCount":15}}\n\n'
			)
		);
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("google", "gemini-3.6-flash", undefined, {
			maxOutputTokens: 1000,
			variant: "high",
		});
		const parts = await collect(
			client,
			target,
			[
				{
					content: [
						{ text: "Inspect", type: "text" },
						{
							data: "aGVsbG8=",
							mediaType: "image/jpeg",
							type: "file",
						},
					],
					role: "user",
				},
			],
			{ system: "System rule", tools: [lookupTool] }
		);

		expect(mock.url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse"
		);
		expect(new Headers(mock.init?.headers).get("x-goog-api-key")).toBe(
			"test-key"
		);
		const body = responseBody(mock);
		expect(body.systemInstruction).toEqual({
			parts: [{ text: "System rule" }],
		});
		expect(body.generationConfig).toEqual({
			maxOutputTokens: 1000,
			thinkingConfig: { thinkingLevel: "high" },
		});
		const contents = body.contents as { parts: unknown[] }[];
		expect(contents[0]?.parts).toEqual([
			{ text: "Inspect" },
			{ inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
		]);
		expect(body.tools).toEqual([
			{
				functionDeclarations: [
					{
						name: "lookup",
						description: "Find a record.",
						parameters: lookupTool.inputSchema,
					},
				],
			},
		]);
		expect(parts.slice(0, -1)).toEqual([
			{ delta: "Think", type: "reasoning-delta" },
			{ delta: "Answer", type: "text-delta" },
			{
				input: { query: "x" },
				toolCallId: "google-tool-1",
				toolName: "lookup",
				type: "tool-call",
			},
		]);
		const finish = parts.at(-1);
		expect(finish).toMatchObject({
			type: "finish",
			usage: {
				inputTokens: 9,
				outputTokens: 6,
				reasoningTokens: 2,
				totalTokens: 15,
			},
		});
		if (finish?.type !== "finish") {
			throw new Error("Expected Google stream to finish.");
		}
		const resumedMock = mockFetch(
			sseResponse('data: {"candidates":[{"finishReason":"STOP"}]}\n\n')
		);
		await collect(createModelClient({ fetch: resumedMock.fetch }), target, [
			{ role: "assistant", content: [], continuation: finish.continuation },
		]);
		const resumedContents = responseBody(resumedMock).contents as {
			parts: unknown[];
		}[];
		if (!Array.isArray(finish.continuation)) {
			throw new Error("Expected Google to return continuation parts.");
		}
		const continuationParts: unknown[] = finish.continuation;
		expect(resumedContents[0]?.parts).toEqual(continuationParts);
		expect(resumedContents[0]?.parts).toContainEqual(
			expect.objectContaining({ thoughtSignature: "signed-google" })
		);
	});

	test("routes OpenCode Go OpenAI models through Responses", async () => {
		const mock = mockFetch(sseResponse("data: [DONE]\n\n"));
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("opencode-go", "gpt-5.6-luna", undefined, {
			maxOutputTokens: 320,
			variant: "high",
		});

		await collect(client, target);

		expect(mock.url).toBe("https://opencode.ai/zen/go/v1/responses");
		expect(new Headers(mock.init?.headers).get("authorization")).toBe(
			"Bearer test-key"
		);
		expect(responseBody(mock)).toMatchObject({
			model: "gpt-5.6-luna",
			max_output_tokens: 320,
			reasoning: { effort: "high", summary: "detailed" },
		});
	});

	test("routes OpenCode Go Anthropic models through Messages", async () => {
		const mock = mockFetch(
			sseResponse(
				'event: message_start\ndata: {"message":{"usage":{"input_tokens":2}}}\n\n',
				'event: message_delta\ndata: {"usage":{"output_tokens":1}}\n\n',
				"event: message_stop\ndata: {}\n\n"
			)
		);
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("opencode-go", "minimax-m3", undefined, {
			maxOutputTokens: 256,
		});

		const parts = await collect(client, target);

		expect(mock.url).toBe("https://opencode.ai/zen/go/v1/messages");
		expect(new Headers(mock.init?.headers).get("x-api-key")).toBe("test-key");
		expect(responseBody(mock)).toMatchObject({
			model: "minimax-m3",
			max_tokens: 256,
			stream: true,
		});
		expect(parts.at(-1)).toEqual({
			type: "finish",
			usage: { inputTokens: 2, outputTokens: 1 },
		});
	});

	test("routes OpenCode Go compatible models through Chat Completions", async () => {
		const mock = mockFetch(
			sseResponse(
				'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
				'data: {"choices":[{"delta":{"reasoning_content":"Reason"}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\\"query\\":"}}]}}]}\n\n',
				'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
				'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
				"data: [DONE]\n\n"
			)
		);
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("opencode-go", "grok-4.6", undefined, {
			maxOutputTokens: 500,
		});
		const messages: ModelPromptMessage[] = [
			{
				content: [
					{ text: "Earlier call", type: "text" },
					{
						input: { query: "x" },
						toolCallId: "old-call",
						toolName: "lookup",
						type: "tool-call",
					},
				],
				role: "assistant",
			},
			{
				content: [
					{
						output: { found: true },
						toolCallId: "old-call",
						toolName: "lookup",
						type: "tool-result",
					},
				],
				role: "tool",
			},
		];

		const parts = await collect(client, target, messages, {
			tools: [lookupTool],
		});

		expect(mock.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
		expect(responseBody(mock)).toMatchObject({
			model: "grok-4.6",
			max_tokens: 500,
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(responseBody(mock).messages).toEqual([
			{
				role: "assistant",
				content: "Earlier call",
				tool_calls: [
					{
						id: "old-call",
						type: "function",
						function: { name: "lookup", arguments: '{"query":"x"}' },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "old-call",
				content: JSON.stringify({ found: true }),
			},
		]);
		expect(parts).toEqual([
			{ delta: "Hi", type: "text-delta" },
			{ delta: "Reason", type: "reasoning-delta" },
			{
				input: { query: "x" },
				toolCallId: "call-1",
				toolName: "lookup",
				type: "tool-call",
			},
			{
				type: "finish",
				usage: {
					cacheReadTokens: 2,
					inputTokens: 8,
					outputTokens: 4,
					reasoningTokens: 1,
				},
			},
		]);
	});

	test("propagates abort signals through the streaming response body", async () => {
		const streamStarted = Promise.withResolvers<void>();
		const signalStreamStarted = (): void => streamStarted.resolve(undefined);
		const controller = new AbortController();
		const abortReason = new DOMException("Cancelled", "AbortError");
		let forwardedSignal: AbortSignal | undefined;
		const fetch = (async (
			_input: Request | string | URL,
			init?: RequestInit
		) => {
			forwardedSignal = init?.signal ?? undefined;
			return new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						signalStreamStarted();
						const pendingRead = Promise.withResolvers<void>();
						forwardedSignal?.addEventListener(
							"abort",
							() => pendingRead.reject(forwardedSignal?.reason),
							{ once: true }
						);
						return pendingRead.promise;
					},
				}),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}) as typeof globalThis.fetch;
		const client = createModelClient({ fetch });
		const target = makeTarget("openai", "gpt-5.6-luna");
		const pending = collect(client, target, [], { signal: controller.signal });

		await streamStarted.promise;
		controller.abort(abortReason);

		await expect(pending).rejects.toBe(abortReason);
		expect(forwardedSignal).toBe(controller.signal);
	});

	test("preserves provider HTTP failure status and retry-after metadata", async () => {
		const mock = mockFetch(
			new Response(JSON.stringify({ error: { message: "Slow down" } }), {
				headers: { "content-type": "application/json", "retry-after": "3" },
				status: 429,
			})
		);
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("openai", "gpt-5.6-luna");

		await expect(collect(client, target)).rejects.toMatchObject({
			message: expect.stringContaining("Slow down"),
			retryAfterMs: 3000,
			statusCode: 429,
		});
	});

	test("surfaces protocol failure events and retry metadata", async () => {
		const mock = mockFetch(
			sseResponse(
				'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"status":502,"message":"Generation failed","retry_after_ms":750}}}\n\n'
			)
		);
		const client = createModelClient({ fetch: mock.fetch });
		const target = makeTarget("openai", "gpt-5.6-luna");

		await expect(collect(client, target)).rejects.toMatchObject({
			message: expect.stringContaining("Generation failed"),
			retryAfterMs: 750,
			statusCode: 502,
		});
	});

	test("generates text from a prompt and applies its output budget", async () => {
		const mock = mockFetch(
			sseResponse(
				'event: response.output_text.delta\ndata: {"delta":"Native "}\n\n',
				'event: response.output_text.delta\ndata: {"delta":"answer"}\n\n',
				'event: response.completed\ndata: {"response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
			)
		);
		const target = makeTarget("openai", "gpt-5.6-luna", undefined, {
			maxOutputTokens: 500,
		});
		const result: ModelTextGenerationResult = await generateModelText(
			{
				maxOutputTokens: 90,
				model: target,
				prompt: "Question",
				system: "Answer directly.",
			},
			createModelClient({ fetch: mock.fetch })
		);

		expect(result).toEqual({
			text: "Native answer",
			usage: { inputTokens: 3, outputTokens: 2 },
		});
		expect(responseBody(mock)).toMatchObject({
			instructions: "Answer directly.",
			max_output_tokens: 90,
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: "Question" }],
				},
			],
		});
	});

	test("generates text from ordered model messages", async () => {
		const mock = mockFetch(
			sseResponse(
				'event: response.output_text.delta\ndata: {"delta":"Follow-up"}\n\n',
				'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":2}}}\n\n'
			)
		);
		const result = await generateModelText(
			{
				maxOutputTokens: 120,
				messages: [
					{ content: "Previous answer", role: "assistant" },
					{ content: "Continue", role: "user" },
				],
				model: makeTarget("openai", "gpt-5.6-luna"),
				system: "Keep context.",
			},
			createModelClient({ fetch: mock.fetch })
		);

		expect(result).toEqual({
			text: "Follow-up",
			usage: { inputTokens: 5, outputTokens: 2 },
		});
		expect(responseBody(mock)).toMatchObject({
			instructions: "Keep context.",
			input: [
				{
					role: "assistant",
					content: [{ type: "output_text", text: "Previous answer" }],
				},
				{
					role: "user",
					content: [{ type: "input_text", text: "Continue" }],
				},
			],
		});
	});
});
