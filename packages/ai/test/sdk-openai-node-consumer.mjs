import assert from "node:assert/strict";
import { createOpenAIProvider, createProviderCollection } from "@wincode/ai";

const sdk = createProviderCollection();
let apiKeyHeader;
sdk.register(
	createOpenAIProvider({
		fetch: async (input, init) => {
			assert.equal(String(input), "https://api.openai.com/v1/responses");
			apiKeyHeader = new Headers(init?.headers).get("authorization");
			return new Response(
				[
					`data: {"type":"response.output_text.delta","delta":"external"}\n\n`,
					`data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`,
				].join(""),
				{ headers: { "content-type": "text/event-stream" } }
			);
		},
	})
);
await sdk.setCredential("openai", {
	kind: "api-key",
	apiKey: "node-openai-key",
});

const events = [];
for await (const event of sdk.chat({
	messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
	modelId: "gpt-5.6",
	providerId: "openai",
})) {
	events.push(event);
}

assert.equal(apiKeyHeader, "Bearer node-openai-key");
assert.deepEqual(events, [
	{ delta: "external", type: "text-delta" },
	{ type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
	{
		type: "terminal",
		outcome: {
			completion: { kind: "completed" },
			continuation: [],
			status: "success",
		},
	},
]);
