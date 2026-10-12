import assert from "node:assert/strict";
import { createProviderCollection } from "@wincode/ai/sdk";
import { createDeepSeekProvider } from "@wincode/ai/sdk/providers/deepseek";
import { createOpenRouterProvider } from "@wincode/ai/sdk/providers/openrouter";

const credentials = new Map();
const modelSnapshots = new Map();
const credentialStore = {
	delete: (providerId) => credentials.delete(providerId),
	get: (providerId) => credentials.get(providerId),
	set: (providerId, credential) => credentials.set(providerId, credential),
};
const modelStore = {
	get: (providerId) => modelSnapshots.get(providerId),
	set: (providerId, models) => modelSnapshots.set(providerId, models),
};
const calls = [];
const sse = (events) =>
	new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } }
	);
const sdk = createProviderCollection({ credentialStore, modelStore });
sdk.register(
	createDeepSeekProvider({
		fetch: async (input, init) => {
			calls.push({
				authorization: new Headers(init?.headers).get("authorization"),
				body: JSON.parse(String(init?.body)),
				url: String(input),
			});
			return sse([
				{ choices: [{ delta: { content: "DeepSeek via SDK" } }] },
				{
					choices: [{ delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
				},
			]);
		},
	})
);
sdk.register(
	createOpenRouterProvider({
		fetch: async (input, init) => {
			const url = String(input);
			calls.push({
				authorization: new Headers(init?.headers).get("authorization"),
				...(init?.body === undefined
					? {}
					: { body: JSON.parse(String(init.body)) }),
				url,
			});
			return url.endsWith("/models")
				? Response.json({ data: [{ id: "org/model-with/vendor-id" }] })
				: sse([
						{ choices: [{ delta: { content: "OpenRouter via SDK" } }] },
						{
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: {
								prompt_tokens: 3,
								completion_tokens: 1,
								total_tokens: 4,
							},
						},
					]);
		},
	})
);

assert.equal(
	sdk.getModel("deepseek", "deepseek-chat").protocolId,
	"openai-compatible"
);
await sdk.setCredential("deepseek", {
	kind: "api-key",
	apiKey: "node-deepseek-key",
});
await sdk.setCredential("openrouter", {
	kind: "api-key",
	apiKey: "node-openrouter-key",
});
const openRouterModels = await sdk.refreshModels("openrouter");
assert.equal(openRouterModels[0].modelId, "org/model-with/vendor-id");

const collect = async (providerId, modelId) => {
	const events = [];
	for await (const event of sdk.chat({
		messages: [{ content: [{ text: "hello", type: "text" }], role: "user" }],
		modelId,
		providerId,
	})) {
		events.push(event);
	}
	return events;
};
const deepSeekEvents = await collect("deepseek", "deepseek-chat");
const openRouterEvents = await collect(
	"openrouter",
	openRouterModels[0].modelId
);
assert.equal(deepSeekEvents.at(-1).outcome.status, "success");
assert.equal(openRouterEvents.at(-1).outcome.status, "success");
assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
assert.equal(calls[1].url, "https://api.deepseek.com/chat/completions");
assert.equal(calls[1].body.model, "deepseek-chat");
assert.equal(calls[2].url, "https://openrouter.ai/api/v1/chat/completions");
assert.equal(calls[2].body.model, "org/model-with/vendor-id");
assert.equal(calls[1].authorization, "Bearer node-deepseek-key");
assert.equal(calls[2].authorization, "Bearer node-openrouter-key");
assert.doesNotMatch(
	JSON.stringify([deepSeekEvents, openRouterEvents]),
	/node-(?:deepseek|openrouter)-key/
);

const offline = createProviderCollection({ credentialStore, modelStore });
offline.register(
	createDeepSeekProvider({
		fetch: async () => {
			throw new Error("offline");
		},
	})
);
offline.register(
	createOpenRouterProvider({
		fetch: async () => {
			throw new Error("offline");
		},
	})
);
await offline.restoreModels();
assert.equal(
	offline.getModel("deepseek", "deepseek-reasoner").modelId,
	"deepseek-reasoner"
);
assert.equal(
	offline.getModel("openrouter", "org/model-with/vendor-id").protocolId,
	"openai-compatible"
);
assert.deepEqual(await offline.getAvailable(), offline.getModels());
