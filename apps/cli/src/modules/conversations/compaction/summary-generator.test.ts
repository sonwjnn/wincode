import { expect, mock, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai";
import type { LanguageModel } from "ai";
import {
	COMPACTION_SUMMARY_SYSTEM_PROMPT,
	createHostedSummaryGenerator,
	createLanguageModelSummaryGenerator,
} from "./summary-generator";

const directModel: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};

const hostedModel: ChatModelSelection = {
	modelId: "gemini-2.5-flash",
	providerId: "wincode",
};

test("runs summary generation with the effective model, no tools, and cancellation", async () => {
	const signal = new AbortController().signal;
	const model = {} as LanguageModel;
	const generate = mock(async (options) => ({
		text: "preserved decisions",
		usage: { inputTokens: 20, outputTokens: 4 },
		...options,
	}));
	const resolveModel = mock(async () => ({ model }));
	const generator = createLanguageModelSummaryGenerator({
		generate,
		resolveModel,
	});

	const result = await generator({
		focus: "keep identifiers",
		model: directModel,
		previousSummary: {
			coveredMessageIds: ["old"],
			formatVersion: 1,
			text: "previous decisions",
		},
		serializedMessages: "message id=u1",
		signal,
	});

	expect(result).toEqual({
		text: "preserved decisions",
		usage: { inputTokens: 20, outputTokens: 4 },
	});
	expect(resolveModel).toHaveBeenCalledWith(directModel, signal);
	expect(generate).toHaveBeenCalledWith(
		expect.objectContaining({
			abortSignal: signal,
			maxRetries: 0,
			model,
			system: COMPACTION_SUMMARY_SYSTEM_PROMPT,
		})
	);
	expect(generate.mock.calls[0]?.[0].prompt).toContain("keep identifiers");
});

test("hosted adapter forwards authorization, model, and abort signal", async () => {
	const signal = new AbortController().signal;
	const fetch = mock(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe(hostedModel.modelId);
		expect(init?.signal).toBe(signal);
		return Response.json({ text: "hosted summary" });
	});
	const authorize = mock(async () => ({
		kind: "bearer" as const,
		token: "secret",
	}));
	const generator = createHostedSummaryGenerator({
		connections: { authorize } as never,
		fetch: fetch as unknown as typeof globalThis.fetch,
		getBaseUrl: () => "https://example.test",
		sessionId: "session-1",
	});

	const result = await generator({
		model: hostedModel,
		serializedMessages: "message id=u1",
		signal,
	});

	expect(result).toEqual({ text: "hosted summary" });
	expect(authorize).toHaveBeenCalledWith("wincode", signal);
	expect(fetch).toHaveBeenCalledWith(
		"https://example.test/api/sessions/session-1/compact-summary",
		expect.objectContaining({
			headers: expect.objectContaining({ Authorization: "Bearer secret" }),
		})
	);
});
