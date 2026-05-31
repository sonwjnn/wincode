import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { prepareSendChatRequestBody } from "./chat-request";

const userMessage = {
	id: "user-1",
	metadata: {
		mode: "plan",
		model: "gemini-3.5-flash",
	},
	parts: [{ text: "hello", type: "text" }],
	role: "user",
} satisfies CodingAgentUIMessage;

const assistantMessage = {
	id: "assistant-1",
	metadata: {
		mode: "plan",
		model: "gemini-3.5-flash",
	},
	parts: [
		{
			input: { path: "README.md" },
			output: { content: "ok", path: "README.md" },
			state: "output-available",
			toolCallId: "call-1",
			type: "tool-read",
		},
	],
	role: "assistant",
} satisfies CodingAgentUIMessage;

describe("prepareSendChatRequestBody", () => {
	test("sends latest user message with mode and model", () => {
		expect(prepareSendChatRequestBody("session-1", [userMessage])).toEqual({
			message: userMessage,
			mode: "plan",
			model: "gemini-3.5-flash",
			sendReasoning: true,
		});
	});

	test("sends updated assistant message after local tool output", () => {
		expect(
			prepareSendChatRequestBody("session-1", [userMessage, assistantMessage])
		).toEqual({
			message: assistantMessage,
			mode: "plan",
			model: "gemini-3.5-flash",
			sendReasoning: true,
		});
	});

	test("falls back to previous metadata when latest message has none", () => {
		const nextMessage = {
			id: "user-2",
			parts: [{ text: "continue", type: "text" }],
			role: "user",
		} satisfies CodingAgentUIMessage;

		expect(
			prepareSendChatRequestBody("session-1", [userMessage, nextMessage])
		).toEqual({
			message: nextMessage,
			mode: "plan",
			model: "gemini-3.5-flash",
			sendReasoning: true,
		});
	});

	test("uses fallback metadata when no messages include metadata", () => {
		const nextMessage = {
			id: "user-2",
			parts: [{ text: "continue", type: "text" }],
			role: "user",
		} satisfies CodingAgentUIMessage;

		expect(
			prepareSendChatRequestBody("session-1", [nextMessage], {
				mode: "build",
				model: "gpt-5.4-mini",
			})
		).toEqual({
			message: nextMessage,
			mode: "build",
			model: "gpt-5.4-mini",
			sendReasoning: true,
		});
	});

	test("throws when no message can be sent", () => {
		expect(() => prepareSendChatRequestBody("session-1", [])).toThrow(
			"No message to send"
		);
	});
});
