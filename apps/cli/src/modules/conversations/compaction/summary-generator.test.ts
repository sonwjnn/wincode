import { expect, mock, test } from "bun:test";
import { createModelTarget } from "@wincode/ai/model-target";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { ConversationMessage } from "../message";
import {
	createLanguageModelSummaryGenerator,
	type SummaryTextGenerationOptions,
} from "./summary-generator";

const selection: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
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
	const assistantMessage: ConversationMessage = {
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

	await generator({
		model: selection,
		serializedMessages: "fallback transcript",
		summaryMessages: [assistantMessage],
	});

	const messages = generate.mock.calls[0]?.[0].messages;
	expect(messages).toHaveLength(2);
	expect(messages?.[1]?.content).toContain('"toolCallId":"call-1"');
	expect(messages?.[1]?.content).toContain(
		'"output":{"exitCode":0,"output":"/workspace"}'
	);
	expect(messages?.[1]?.content).toContain('"toolCallId":"call-2"');
	expect(messages?.[1]?.content).toContain('"errorText":"permission denied"');
});
