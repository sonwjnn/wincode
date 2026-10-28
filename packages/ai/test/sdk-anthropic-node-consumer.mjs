import assert from "node:assert/strict";
import { createAnthropicProvider, createProviderCollection } from "@wincode/ai";

const sdk = createProviderCollection();
let apiKeyHeader;
let body;
sdk.register(
	createAnthropicProvider({
		fetch: async (input, init) => {
			assert.equal(String(input), "https://api.anthropic.com/v1/messages");
			apiKeyHeader = new Headers(init?.headers).get("x-api-key");
			body = JSON.parse(String(init?.body));
			return new Response(
				[
					'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":2}}}\n\n',
					'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
					'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Reasoned"}}\n\n',
					'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
					'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
					'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello from Claude"}}\n\n',
					'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
					'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call-1","name":"lookup","input":{}}}\n\n',
					'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"weather\\"}"}}\n\n',
					'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
					'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
					'event: message_stop\ndata: {"type":"message_stop"}\n\n',
				].join(""),
				{ headers: { "content-type": "text/event-stream" } }
			);
		},
	})
);
await sdk.setCredential("anthropic", {
	apiKey: "node-anthropic-key",
	kind: "api-key",
});

const events = [];
for await (const event of sdk.chat({
	messages: [{ content: [{ text: "Question", type: "text" }], role: "user" }],
	modelId: "claude-sonnet-4-6",
	providerId: "anthropic",
})) {
	events.push(event);
}

assert.equal(apiKeyHeader, "node-anthropic-key");
assert.equal(body.model, "claude-sonnet-4-6");
assert.deepEqual(events, [
	{ delta: "Reasoned", type: "reasoning-delta" },
	{ delta: "Hello from Claude", type: "text-delta" },
	{
		input: { q: "weather" },
		toolCallId: "call-1",
		toolName: "lookup",
		type: "tool-call",
	},
	{
		type: "usage",
		usage: { cacheReadTokens: 2, inputTokens: 7, outputTokens: 3 },
	},
	{
		type: "terminal",
		outcome: {
			completion: { kind: "completed" },
			continuation: [
				{ thinking: "Reasoned", type: "thinking" },
				{ text: "Hello from Claude", type: "text" },
				{
					id: "call-1",
					input: { q: "weather" },
					name: "lookup",
					type: "tool_use",
				},
			],
			status: "success",
		},
	},
]);
