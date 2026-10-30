import { expect, test } from "bun:test";
import {
	type ChatEvent,
	createConfiguredProvider,
	createProviderCollection,
	type ProviderModel,
} from "@wincode/ai";
import { createInMemoryCredentialStore } from "./support/credential-store.ts";

const sseResponse = (events: readonly Readonly<Record<string, unknown>>[]) =>
	new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } }
	);

const models: readonly ProviderModel[] = [
	{
		modelId: "chat-model",
		name: "OpenAI Chat Model",
		protocolId: "openai-chat",
		providerId: "configured-hybrid",
	},
	{
		modelId: "responses-model",
		name: "OpenAI Responses Model",
		protocolId: "openai-responses",
		providerId: "configured-hybrid",
	},
	{
		modelId: "compatible-model",
		name: "Compatible Model",
		protocolId: "openai-compatible",
		providerId: "configured-hybrid",
	},
	{
		modelId: "anthropic-model",
		name: "Anthropic Messages Model",
		protocolId: "anthropic",
		providerId: "configured-hybrid",
	},
	{
		modelId: "google-model",
		name: "Google Generative AI Model",
		protocolId: "google",
		providerId: "configured-hybrid",
	},
];

test("configured Providers route every supported protocol without changing exact model identity", async () => {
	const credentials = new Map<string, unknown>();
	const requests: Array<{
		body: Record<string, unknown>;
		headers: Headers;
		url: string;
	}> = [];
	const apiKeyReads: string[] = [];
	const fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				headers: new Headers(init?.headers),
				url,
			});
			if (url.includes("anthropic.example")) {
				return sseResponse([
					{
						type: "message_start",
						message: { usage: { input_tokens: 1, output_tokens: 0 } },
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Anthropic" },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: { output_tokens: 1 },
					},
					{ type: "message_stop" },
				]);
			}
			if (url.includes("google.example")) {
				return sseResponse([
					{
						candidates: [
							{
								content: { parts: [{ text: "Google" }], role: "model" },
								finishReason: "STOP",
							},
						],
					},
				]);
			}
			if (url.endsWith("/responses")) {
				return sseResponse([
					{ type: "response.output_text.delta", delta: "Responses" },
					{
						type: "response.completed",
						response: {
							output: [],
							usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
						},
					},
				]);
			}
			if (url.includes("compatible.example")) {
				return sseResponse([
					{ choices: [{ delta: { content: "Compatible" } }] },
					{ choices: [{ delta: {}, finish_reason: "stop" }] },
				]);
			}
			return sseResponse([
				{ choices: [{ delta: { content: "Chat" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			]);
		},
		{ preconnect: () => undefined }
	);
	const collection = createProviderCollection({
		credentialStore: createInMemoryCredentialStore(credentials),
	});
	collection.register(
		createConfiguredProvider({
			baseUrl: "https://openai.example/v1",
			fetch,
			id: "configured-hybrid",
			modelBaseUrls: {
				"anthropic-model": "https://anthropic.example/v1",
				"compatible-model": "https://compatible.example/v1",
				"google-model": "https://google.example/v1beta/models",
			},
			models,
			resolveApiKey: async () => {
				apiKeyReads.push("configured-source");
				return "configured-key";
			},
		})
	);
	await collection.setCredential("configured-hybrid", {
		apiKey: "stored-key",
		kind: "api-key",
	});

	try {
		expect(await collection.getAvailable("configured-hybrid")).toEqual(models);
		for (const model of models) {
			const events: ChatEvent[] = [];
			for await (const event of collection.chat({
				messages: [
					{ content: [{ text: "Hello", type: "text" }], role: "user" },
				],
				modelId: model.modelId,
				providerId: model.providerId,
			})) {
				events.push(event);
			}
			expect(events.at(-1)).toMatchObject({
				outcome: { status: "success" },
				type: "terminal",
			});
		}

		expect(requests.map(({ url }) => url)).toEqual([
			"https://openai.example/v1/chat/completions",
			"https://openai.example/v1/responses",
			"https://compatible.example/v1/chat/completions",
			"https://anthropic.example/v1/messages",
			"https://google.example/v1beta/models/google-model:streamGenerateContent?alt=sse",
		]);
		expect(requests.slice(0, 4).map(({ body }) => body.model)).toEqual(
			models.slice(0, 4).map(({ modelId }) => modelId)
		);
		expect(requests[4]?.url).toContain("google-model:streamGenerateContent");
		expect(requests.map(({ headers }) => headers.get("authorization"))).toEqual(
			[
				"Bearer stored-key",
				"Bearer stored-key",
				"Bearer stored-key",
				null,
				null,
			]
		);
		expect(requests[3]?.headers.get("x-api-key")).toBe("stored-key");
		expect(requests[4]?.headers.get("x-goog-api-key")).toBe("stored-key");
		expect(apiKeyReads).toEqual([]);
	} finally {
		await collection.close();
	}
});

test("unregistered protocol IDs fail instead of resolving inherited adapter keys", () => {
	for (const protocolId of ["unknown-protocol", "constructor", "__proto__"]) {
		expect(() =>
			createConfiguredProvider({
				id: "unsupported-provider",
				models: [
					{
						modelId: "unsupported-model",
						protocolId,
						providerId: "unsupported-provider",
					},
				],
			})
		).toThrow(`Unsupported configured Provider protocol '${protocolId}'.`);
	}
});
