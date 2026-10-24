import { describe, expect, test } from "bun:test";
import {
	type AnthropicFetch,
	type ChatEvent,
	createAnthropicProvider,
	createProviderCollection,
} from "@wincode/ai";
import { createInMemoryCredentialStore } from "./support/credential-store.ts";

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

describe("public Anthropic SDK provider", () => {
	test("API-key consumers receive Anthropic text, reasoning, tool, usage, and continuation events", async () => {
		const continuation = [
			{
				type: "thinking",
				thinking: "Checking the forecast",
				signature: "signed-thinking",
			},
			{ type: "text", text: "Forecast: sunny." },
			{
				type: "tool_use",
				id: "call-weather",
				name: "weather",
				input: { city: "Paris" },
			},
		];
		const requests: {
			body: Record<string, unknown>;
			headers: Headers;
			url: string;
		}[] = [];
		const credentials = new Map<string, unknown>();
		const sdk = createProviderCollection({
			credentialStore: createInMemoryCredentialStore(credentials),
		});
		sdk.register(
			createAnthropicProvider({
				fetch: async (input, init) => {
					requests.push({
						body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						headers: new Headers(init?.headers),
						url: String(input),
					});
					return sseResponse([
						{
							type: "message_start",
							message: {
								usage: {
									input_tokens: 11,
									cache_read_input_tokens: 4,
									cache_creation_input_tokens: 2,
								},
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "thinking", thinking: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: {
								type: "thinking_delta",
								thinking: "Checking the forecast",
							},
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "signature_delta", signature: "signed-thinking" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "content_block_start",
							index: 1,
							content_block: { type: "text", text: "" },
						},
						{
							type: "content_block_delta",
							index: 1,
							delta: { type: "text_delta", text: "Forecast: sunny." },
						},
						{ type: "content_block_stop", index: 1 },
						{
							type: "content_block_start",
							index: 2,
							content_block: {
								type: "tool_use",
								id: "call-weather",
								name: "weather",
								input: {},
							},
						},
						{
							type: "content_block_delta",
							index: 2,
							delta: {
								type: "input_json_delta",
								partial_json: '{"city":"Paris"}',
							},
						},
						{ type: "content_block_stop", index: 2 },
						{
							type: "message_delta",
							delta: { stop_reason: "tool_use" },
							usage: { output_tokens: 5 },
						},
						{ type: "message_stop" },
					]);
				},
			})
		);
		await sdk.setCredential("anthropic", {
			apiKey: "anthropic-app-secret",
			kind: "api-key",
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [{ text: "Weather in Paris?", type: "text" }],
					role: "user",
				},
			],
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
			reasoningEffort: "high",
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

		expect(credentials.get("anthropic")).toEqual({
			apiKey: "anthropic-app-secret",
			kind: "api-key",
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(requests[0]?.headers.get("x-api-key")).toBe("anthropic-app-secret");
		expect(requests[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(requests[0]?.body).toMatchObject({
			model: "claude-sonnet-4-6",
			stream: true,
			max_tokens: 128_000,
			output_config: { effort: "high" },
			system: "Be concise.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Weather in Paris?" }],
				},
			],
			tools: [
				{
					name: "weather",
					description: "Get a forecast.",
					input_schema: {
						properties: { city: { type: "string" } },
						required: ["city"],
						type: "object",
					},
				},
			],
		});
		expect(events).toEqual([
			{ delta: "Checking the forecast", type: "reasoning-delta" },
			{ delta: "Forecast: sunny.", type: "text-delta" },
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
					cacheWriteTokens: 2,
					inputTokens: 17,
					outputTokens: 5,
				},
			},
			{
				outcome: {
					completion: { kind: "completed" },
					continuation,
					status: "success",
				},
				type: "terminal",
			},
		]);
		expect(JSON.stringify(events)).not.toContain("anthropic-app-secret");
		expect(
			sdk.getModel("anthropic", "claude-sonnet-4-6")?.reasoningEfforts
		).not.toContain("minimal");
		for await (const _event of sdk.chat({
			messages: [
				{
					content: [{ text: "Unsupported effort?", type: "text" }],
					role: "user",
				},
			],
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
			reasoningEffort: "minimal",
		})) {
			// Consume the fake stream to inspect the serialized request.
		}
		expect(requests[1]?.body).not.toHaveProperty("output_config");
	});

	test("tool follow-ups preserve opaque Anthropic continuation and multimodal user inputs", async () => {
		const continuation = [
			{ type: "thinking", thinking: "Plan", signature: "sig-plan" },
			{ type: "text", text: "Checking the image." },
			{
				type: "tool_use",
				id: "call-vision",
				name: "inspect",
				input: { detail: "label" },
			},
		];
		const bodies: Record<string, unknown>[] = [];
		let call = 0;
		const sdk = createProviderCollection();
		sdk.register(
			createAnthropicProvider({
				fetch: async (_input, init) => {
					bodies.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>
					);
					call += 1;
					return call === 1
						? sseResponse([
								{
									type: "content_block_start",
									index: 0,
									content_block: {
										type: "thinking",
										thinking: "",
									},
								},
								{
									type: "content_block_delta",
									index: 0,
									delta: { type: "thinking_delta", thinking: "Plan" },
								},
								{
									type: "content_block_delta",
									index: 0,
									delta: { type: "signature_delta", signature: "sig-plan" },
								},
								{ type: "content_block_stop", index: 0 },
								{
									type: "content_block_start",
									index: 1,
									content_block: { type: "text", text: "" },
								},
								{
									type: "content_block_delta",
									index: 1,
									delta: {
										type: "text_delta",
										text: "Checking the image.",
									},
								},
								{ type: "content_block_stop", index: 1 },
								{
									type: "content_block_start",
									index: 2,
									content_block: {
										type: "tool_use",
										id: "call-vision",
										name: "inspect",
										input: {},
									},
								},
								{
									type: "content_block_delta",
									index: 2,
									delta: {
										type: "input_json_delta",
										partial_json: '{"detail":"label"}',
									},
								},
								{ type: "content_block_stop", index: 2 },
								{
									type: "message_delta",
									delta: { stop_reason: "tool_use" },
								},
								{ type: "message_stop" },
							])
						: sseResponse([
								{
									type: "content_block_start",
									index: 0,
									content_block: { type: "text", text: "" },
								},
								{
									type: "content_block_delta",
									index: 0,
									delta: { type: "text_delta", text: "The label is red." },
								},
								{ type: "content_block_stop", index: 0 },
								{
									type: "message_delta",
									delta: { stop_reason: "end_turn" },
								},
								{ type: "message_stop" },
							]);
				},
			})
		);
		await sdk.setCredential("anthropic", {
			apiKey: "follow-up-key",
			kind: "api-key",
		});

		const firstEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [
						{ text: "What is in this picture?", type: "text" },
						{ data: "aW1hZ2U=", mediaType: "image/png", type: "image" },
					],
					role: "user",
				},
			],
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
		})) {
			firstEvents.push(event);
		}
		const firstTerminal = firstEvents.at(-1);
		const returnedContinuation =
			firstTerminal?.type === "terminal" &&
			firstTerminal.outcome.status === "success"
				? firstTerminal.outcome.continuation
				: undefined;
		const secondEvents: ChatEvent[] = [];
		for await (const event of sdk.chat({
			messages: [
				{
					content: [
						{ text: "Checking the image.", type: "text" },
						{
							input: { detail: "label" },
							toolCallId: "call-vision",
							toolName: "inspect",
							type: "tool-call",
						},
					],
					continuation: returnedContinuation,
					role: "assistant",
				},
				{
					content: [
						{
							output: { label: "red" },
							toolCallId: "call-vision",
							toolName: "inspect",
							type: "tool-result",
						},
					],
					role: "tool",
				},
				{
					content: [
						{ text: "Compare with this document.", type: "text" },
						{
							data: "ZG9j",
							mediaType: "application/pdf",
							type: "file",
						},
					],
					role: "user",
				},
			],
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
		})) {
			secondEvents.push(event);
		}

		expect(firstTerminal).toEqual({
			outcome: {
				completion: { kind: "completed" },
				continuation,
				status: "success",
			},
			type: "terminal",
		});
		expect(bodies).toHaveLength(2);
		const firstMessages = bodies[0]?.messages as Record<string, unknown>[];
		expect(firstMessages[0]?.content).toEqual([
			{ text: "What is in this picture?", type: "text" },
			{
				source: { data: "aW1hZ2U=", media_type: "image/png", type: "base64" },
				type: "image",
			},
		]);
		const secondMessages = bodies[1]?.messages as Record<string, unknown>[];
		expect(secondMessages[0]).toEqual({
			role: "assistant",
			content: continuation,
		});
		expect(secondMessages[1]).toEqual({
			role: "user",
			content: [
				{
					content: '{"label":"red"}',
					tool_use_id: "call-vision",
					type: "tool_result",
				},
			],
		});
		expect(secondMessages[2]?.content).toEqual([
			{ text: "Compare with this document.", type: "text" },
			{
				source: { data: "ZG9j", media_type: "application/pdf", type: "base64" },
				type: "document",
			},
		]);
		expect(secondEvents.at(-1)).toEqual({
			outcome: {
				completion: { kind: "completed" },
				continuation: [{ text: "The label is red.", type: "text" }],
				status: "success",
			},
			type: "terminal",
		});
	});

	test("cache-control rejection retries once without Anthropic cache directives", async () => {
		const bodies: Record<string, unknown>[] = [];
		let calls = 0;
		const sdk = createProviderCollection();
		sdk.register(
			createAnthropicProvider({
				fetch: async (_input, init) => {
					calls += 1;
					bodies.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>
					);
					if (calls === 1) {
						return Response.json(
							{ error: { message: "cache_control is not supported" } },
							{ status: 400 }
						);
					}
					return sseResponse([
						{
							type: "message_start",
							message: { usage: { input_tokens: 7 } },
						},
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { output_tokens: 2 },
						},
						{ type: "message_stop" },
					]);
				},
			})
		);
		await sdk.setCredential("anthropic", {
			apiKey: "cache-fallback-key",
			kind: "api-key",
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "short",
			messages: [
				{ content: [{ text: "Summarize this", type: "text" }], role: "user" },
			],
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
			system: "Stable instructions.",
		})) {
			events.push(event);
		}

		expect(calls).toBe(2);
		expect(bodies[0]?.system).toEqual([
			{
				cache_control: { type: "ephemeral" },
				text: "Stable instructions.",
				type: "text",
			},
		]);
		expect(bodies[1]?.system).toEqual("Stable instructions.");
		expect(events).toEqual([
			{
				type: "usage",
				usage: { inputTokens: 7, outputTokens: 2 },
			},
			{
				outcome: { completion: { kind: "completed" }, status: "success" },
				type: "terminal",
			},
		]);
	});

	test("cache retention is best-effort for Anthropic models without published cache support", async () => {
		let body: Record<string, unknown> | undefined;
		const sdk = createProviderCollection();
		sdk.register(
			createAnthropicProvider({
				models: [
					{
						modelId: "private-claude",
						protocolId: "anthropic",
						providerId: "anthropic",
					},
				],
				fetch: async (_input, init) => {
					body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return sseResponse([{ type: "message_stop" }]);
				},
			})
		);
		await sdk.setCredential("anthropic", {
			apiKey: "custom-model-key",
			kind: "api-key",
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "long",
			messages: [{ content: [{ text: "Prompt", type: "text" }], role: "user" }],
			modelId: "private-claude",
			providerId: "anthropic",
			system: "Uncacheable metadata is optional.",
		})) {
			events.push(event);
		}

		expect(body?.system).toBe("Uncacheable metadata is optional.");
		expect(JSON.stringify(body)).not.toContain("cache_control");
		expect(events.at(-1)).toEqual({
			outcome: {
				completion: { kind: "unknown" },
				status: "success",
			},
			type: "terminal",
		});
	});

	test("authentication, provider, transport, and abort failures end without a success outcome", async () => {
		const collect = async (
			fetch: AnthropicFetch,
			signal?: AbortSignal
		): Promise<ChatEvent[]> => {
			const sdk = createProviderCollection();
			sdk.register(createAnthropicProvider({ fetch }));
			await sdk.setCredential("anthropic", {
				apiKey: "failure-test-key",
				kind: "api-key",
			});
			const events: ChatEvent[] = [];
			for await (const event of sdk.chat({
				messages: [
					{ content: [{ text: "Hello", type: "text" }], role: "user" },
				],
				modelId: "claude-sonnet-4-6",
				providerId: "anthropic",
				signal,
			})) {
				events.push(event);
			}
			return events;
		};
		const unauthorized = await collect(async () =>
			Response.json({ error: { message: "invalid API key" } }, { status: 401 })
		);
		const providerFailure = await collect(
			async () =>
				new Response(
					[
						'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}\n\n',
						'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"try again later"}}\n\n',
					].join(""),
					{ headers: { "content-type": "text/event-stream" } }
				)
		);
		const transportFailure = await collect(async () => {
			throw new Error("socket closed");
		});
		const abortController = new AbortController();
		const aborted: ChatEvent[] = [];
		const abortSdk = createProviderCollection();
		abortSdk.register(
			createAnthropicProvider({
				fetch: async () =>
					new Response(
						[
							'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
							'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial answer"}}\n\n',
							'event: message_stop\ndata: {"type":"message_stop"}\n\n',
						].join(""),
						{ headers: { "content-type": "text/event-stream" } }
					),
			})
		);
		await abortSdk.setCredential("anthropic", {
			apiKey: "abort-test-key",
			kind: "api-key",
		});
		for await (const event of abortSdk.chat({
			messages: [{ content: [{ text: "Hello", type: "text" }], role: "user" }],
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
			signal: abortController.signal,
		})) {
			aborted.push(event);
			if (event.type === "text-delta") {
				abortController.abort(
					new DOMException("consumer stopped", "AbortError")
				);
			}
		}

		expect(unauthorized).toEqual([
			{
				outcome: {
					failure: {
						code: "authentication",
						message: "Anthropic rejected the configured credential.",
						providerId: "anthropic",
					},
					status: "failure",
				},
				type: "terminal",
			},
		]);
		expect(providerFailure.slice(0, -1)).toEqual([
			{ delta: "partial answer", type: "text-delta" },
		]);
		expect(providerFailure.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "provider", providerId: "anthropic" },
				status: "failure",
			},
			type: "terminal",
		});
		expect(transportFailure.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "transport", providerId: "anthropic" },
				status: "failure",
			},
			type: "terminal",
		});
		expect(aborted.slice(0, -1)).toEqual([
			{ delta: "partial answer", type: "text-delta" },
		]);
		expect(aborted.at(-1)).toEqual({
			outcome: { reason: "consumer stopped", status: "aborted" },
			type: "terminal",
		});
		for (const events of [
			unauthorized,
			providerFailure,
			transportFailure,
			aborted,
		]) {
			expect(
				events.filter(
					(event) =>
						event.type === "terminal" && event.outcome.status === "success"
				)
			).toEqual([]);
		}
	});

	test("cache-control failure after output starts does not replay or turn partial output into success", async () => {
		let calls = 0;
		const sdk = createProviderCollection();
		sdk.register(
			createAnthropicProvider({
				fetch: async () => {
					calls += 1;
					return new Response(
						[
							'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
							'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
							'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"cache_control unsupported"}}\n\n',
						].join(""),
						{ headers: { "content-type": "text/event-stream" } }
					);
				},
			})
		);
		await sdk.setCredential("anthropic", {
			apiKey: "partial-cache-key",
			kind: "api-key",
		});

		const events: ChatEvent[] = [];
		for await (const event of sdk.chat({
			cacheRetention: "short",
			messages: [{ content: [{ text: "Prompt", type: "text" }], role: "user" }],
			modelId: "claude-sonnet-4-6",
			providerId: "anthropic",
			system: "Stable instructions.",
		})) {
			events.push(event);
		}

		expect(calls).toBe(1);
		expect(events.slice(0, -1)).toEqual([
			{ delta: "partial", type: "text-delta" },
		]);
		expect(events.at(-1)).toMatchObject({
			outcome: {
				failure: { code: "provider", providerId: "anthropic" },
				status: "failure",
			},
			type: "terminal",
		});
	});

	test("Anthropic disables declared thinking when the shared reasoning level is off", async () => {
		let body: Record<string, unknown> | undefined;
		const sdk = createProviderCollection();
		sdk.register(
			createAnthropicProvider({
				fetch: async (_url, init) => {
					body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return sseResponse([
						{
							type: "message_start",
							message: { usage: { input_tokens: 1 } },
						},
						{ type: "message_delta", usage: { output_tokens: 0 } },
						{ type: "message_stop" },
					]);
				},
				models: [
					{
						modelId: "off-model",
						protocolId: "anthropic",
						providerId: "anthropic",
						reasoningEfforts: ["off"],
					},
				],
			})
		);
		await sdk.setCredential("anthropic", {
			apiKey: "anthropic-test-key",
			kind: "api-key",
		});

		for await (const _event of sdk.chat({
			messages: [{ content: [{ text: "Hello", type: "text" }], role: "user" }],
			modelId: "off-model",
			providerId: "anthropic",
			reasoningEffort: "off",
		})) {
			// Consume the stream to verify the provider's wire contract.
		}

		expect(body).not.toHaveProperty("thinking");
		expect(body).not.toHaveProperty("output_config");
	});
});
