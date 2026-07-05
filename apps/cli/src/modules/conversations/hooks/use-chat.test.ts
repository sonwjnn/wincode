import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { prepareSendChatRequestBody } from "../api/chat-request";

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
	test("sends full message context with mode and model", () => {
		expect(prepareSendChatRequestBody("session-1", [userMessage])).toEqual({
			messages: [userMessage],
			mode: "plan",
			model: "gemini-3.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("sends updated assistant message after local tool output", () => {
		expect(
			prepareSendChatRequestBody("session-1", [userMessage, assistantMessage])
		).toEqual({
			messages: [userMessage, assistantMessage],
			mode: "plan",
			model: "gemini-3.5-flash",
			persist: false,
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
			messages: [userMessage, nextMessage],
			mode: "plan",
			model: "gemini-3.5-flash",
			persist: false,
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
			messages: [nextMessage],
			mode: "build",
			model: "gpt-5.4-mini",
			persist: false,
			sendReasoning: true,
		});
	});

	test("throws when no message can be sent", () => {
		expect(() => prepareSendChatRequestBody("session-1", [])).toThrow(
			"No message to send"
		);
	});
});
