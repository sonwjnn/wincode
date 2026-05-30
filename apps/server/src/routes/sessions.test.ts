import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { mergeChatMessage } from "../utils/chat-message-merge";

describe("mergeChatMessage", () => {
	test("replaces a persisted message when the client sends updated tool outputs", () => {
		const persistedMessages = [
			{
				id: "assistant-1",
				parts: [
					{
						input: { path: "README.md" },
						state: "input-available",
						toolCallId: "call_1",
						type: "tool-read",
					},
				],
				role: "assistant",
			},
		] as CodingAgentUIMessage[];
		const updatedMessage = {
			id: "assistant-1",
			parts: [
				{
					input: { path: "README.md" },
					output: { content: "hello", path: "README.md" },
					state: "output-available",
					toolCallId: "call_1",
					type: "tool-read",
				},
			],
			role: "assistant",
		} as CodingAgentUIMessage;

		expect(mergeChatMessage(persistedMessages, updatedMessage)).toEqual([
			updatedMessage,
		]);
	});

	test("appends a new client message", () => {
		const persistedMessages = [
			{ id: "user-1", parts: [{ text: "hi", type: "text" }], role: "user" },
		] as CodingAgentUIMessage[];
		const nextMessage = {
			id: "user-2",
			parts: [{ text: "again", type: "text" }],
			role: "user",
		} as CodingAgentUIMessage;

		expect(mergeChatMessage(persistedMessages, nextMessage)).toEqual([
			...persistedMessages,
			nextMessage,
		]);
	});
});
