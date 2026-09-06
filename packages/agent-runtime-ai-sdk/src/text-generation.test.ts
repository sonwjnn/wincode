import { afterEach, expect, mock, test } from "bun:test";
import { createModelTarget } from "@wincode/ai/model-target";
// Keep the process-global Bun module mock complete for the dynamically imported subject.
// biome-ignore lint/performance/noNamespaceImport: mock spread needs the full namespace
import * as realAi from "ai";

const model = createModelTarget(
	{ modelId: "gpt-5.4-mini", providerId: "openai" },
	{ apiKey: "test-key", kind: "api-key" }
);
const oauthModel = createModelTarget(
	{ modelId: "gpt-5.4-mini", providerId: "openai" },
	{ accessToken: "oauth-token", accountId: "oauth-account", kind: "oauth" }
);

afterEach(() => {
	mock.restore();
	mock.clearAllMocks();
});

test("uses a streaming request for summary generation", async () => {
	const calls: unknown[] = [];
	await mock.module("ai", () => ({
		...realAi,
		streamText: (options: unknown) => {
			calls.push(options);
			return {
				consumeStream: async () => undefined,
				text: Promise.resolve("summary"),
				usage: Promise.resolve({ inputTokens: 12, outputTokens: 4 }),
			};
		},
	}));

	const { generateAiSdkText } = await import(
		`./text-generation?test=${crypto.randomUUID()}`
	);
	const result = await generateAiSdkText({
		maxOutputTokens: 4096,
		maxRetries: 0,
		messages: [{ content: "transcript", role: "user" }],
		model,
		system: "Summarize the transcript.",
	});

	expect(result).toEqual({
		text: "summary",
		usage: { inputTokens: 12, outputTokens: 4 },
	});
	expect(calls).toHaveLength(1);
});
test("omits unsupported output limit for OpenAI OAuth requests", async () => {
	const calls: unknown[] = [];
	await mock.module("ai", () => ({
		...realAi,
		streamText: (options: unknown) => {
			calls.push(options);
			return {
				consumeStream: async () => undefined,
				text: Promise.resolve("summary"),
				usage: Promise.resolve({ inputTokens: 12, outputTokens: 4 }),
			};
		},
	}));

	const { generateAiSdkText } = await import(
		`./text-generation?test=${crypto.randomUUID()}`
	);
	await generateAiSdkText({
		maxOutputTokens: 4096,
		maxRetries: 0,
		messages: [{ content: "transcript", role: "user" }],
		model: oauthModel,
		system: "Summarize the transcript.",
	});

	expect(calls).toHaveLength(1);
	expect(calls[0]).not.toHaveProperty("maxOutputTokens");
});
test("preserves provider errors emitted inside stream envelopes", async () => {
	const providerError = { message: "bad request", statusCode: 400 };
	await mock.module("ai", () => ({
		...realAi,
		streamText: () => ({
			consumeStream: async ({
				onError,
			}: {
				onError?: (error: unknown) => void;
			}) => {
				onError?.({ error: providerError });
			},
			text: Promise.resolve(""),
			usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
		}),
	}));

	const { generateAiSdkText } = await import(
		`./text-generation?test=${crypto.randomUUID()}`
	);

	await expect(
		generateAiSdkText({
			maxOutputTokens: 4096,
			maxRetries: 0,
			messages: [{ content: "transcript", role: "user" }],
			model,
			system: "Summarize the transcript.",
		})
	).rejects.toEqual({ error: providerError });
});
