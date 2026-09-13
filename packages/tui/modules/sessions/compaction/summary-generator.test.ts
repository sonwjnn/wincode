import { expect, mock, test } from "bun:test";
import { fromAny } from "@total-typescript/shoehorn";
import { createModelTarget } from "@wincode/ai/model-target";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { SessionMessage } from "../message";
import {
	createLanguageModelSummaryGenerator,
	type SummaryTextGenerationOptions,
} from "./summary-generator";

const selection: ChatModelSelection = {
	modelId: "gpt-5.6-luna",
	providerId: "openai",
};

const model = createModelTarget(selection, {
	apiKey: "test-key",
	kind: "api-key",
});

test("preserves settled tool call details in summary messages", async () => {
	const generate = mock(async (_options: SummaryTextGenerationOptions) => ({
		text: "summary",
	}));
	const generator = createLanguageModelSummaryGenerator({
		generate,
		resolveModel: async () => model,
	});
	const assistantMessage: SessionMessage = {
		id: "assistant-1",
		parts: [
			{ text: "I inspected the workspace.", type: "text" },
			{
				input: { command: "pwd" },
				output: { exitCode: 0, output: "/workspace" },
				state: "output-available",
				toolCallId: "call-1",
				type: "tool-shell",
			},
			{
				errorText: "permission denied",
				input: { path: ".env" },
				state: "output-error",
				toolCallId: "call-2",
				type: "tool-read",
			},
		],
		role: "assistant",
	};

	const toolResultMessage: SessionMessage = fromAny({
		id: "tool-1",
		parts: [
			{
				output: { exitCode: 0, output: "/workspace" },
				toolCallId: "call-1",
				type: "tool-result",
			},
		],
		role: "tool",
	});
	await generator({
		model: selection,
		serializedMessages: "fallback transcript",
		summaryMessages: [assistantMessage, toolResultMessage],
	});

	const messages = generate.mock.calls[0]?.[0].messages;
	expect(messages).toHaveLength(3);
	expect(messages?.[1]?.content).toContain('"toolCallId":"call-1"');
	expect(messages?.[1]?.content).toContain(
		'"output":{"exitCode":0,"output":"/workspace"}'
	);
	expect(messages?.[1]?.content).toContain('"toolCallId":"call-2"');
	expect(messages?.[1]?.content).toContain('"errorText":"permission denied"');
	expect(messages?.[2]?.role).toBe("user");
	expect(messages?.[2]?.content).toContain('"type":"tool-result"');
	expect(messages?.[2]?.content).toContain(
		'"output":{"exitCode":0,"output":"/workspace"}'
	);
});
test("caps the requested summary budget at the resolved model limit", async () => {
	const generate = mock(async (_options: SummaryTextGenerationOptions) => ({
		text: "summary",
	}));
	const limitedModel = {
		...model,
		maxOutputTokens: 128,
	};
	const generator = createLanguageModelSummaryGenerator({
		generate,
		resolveModel: async () => limitedModel,
	});

	await generator({
		maxOutputTokens: 512,
		model: selection,
		serializedMessages: "transcript",
	});

	expect(generate.mock.calls[0]?.[0].maxOutputTokens).toBe(128);
});
