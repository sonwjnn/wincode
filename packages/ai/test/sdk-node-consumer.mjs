import assert from "node:assert/strict";
import { createProviderCollection } from "@wincode/ai";

const sdk = createProviderCollection();
sdk.register({
	id: "node-consumer-provider",
	models: [
		{
			modelId: "custom-chat",
			protocolId: "node-consumer-wire",
			providerId: "node-consumer-provider",
		},
	],
	resolveAuthorization: async ({ credential }) =>
		credential === undefined ? null : { authorization: credential },
	async *streamChat(request, context) {
		assert.equal(context.model.protocolId, "node-consumer-wire");
		assert.equal(context.authorization, "node-owned-secret");
		assert.equal(request.messages[0].content[1].type, "image");
		yield { delta: "hello", type: "text-delta" };
		yield { delta: "considering the image", type: "reasoning-delta" };
		yield {
			input: { location: "Paris" },
			toolCallId: "weather-call",
			toolName: "weather",
			type: "tool-call",
		};
		yield { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } };
	},
});
await sdk.setCredential("node-consumer-provider", "node-owned-secret");

const events = [];
for await (const event of sdk.chat({
	messages: [
		{
			content: [
				{ text: "what is this", type: "text" },
				{ data: "aW1hZ2U=", mediaType: "image/png", type: "image" },
			],
			role: "user",
		},
	],
	modelId: "custom-chat",
	providerId: "node-consumer-provider",
})) {
	events.push(event);
}

assert.deepEqual(events, [
	{ delta: "hello", type: "text-delta" },
	{ delta: "considering the image", type: "reasoning-delta" },
	{
		input: { location: "Paris" },
		toolCallId: "weather-call",
		toolName: "weather",
		type: "tool-call",
	},
	{ type: "usage", usage: { inputTokens: 3, outputTokens: 1 } },
	{
		type: "terminal",
		outcome: { completion: { kind: "unknown" }, status: "success" },
	},
]);
