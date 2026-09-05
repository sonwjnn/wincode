import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "@/modules/conversations/message";

import { getMostRecentSession, mergePendingInitialMessage } from "./utils";

const userMessage = {
	id: "user-1",
	parts: [{ text: "hello", type: "text" }],
	role: "user",
} satisfies ConversationMessage;

const assistantMessage = {
	id: "assistant-1",
	parts: [{ text: "hi", type: "text" }],
	role: "assistant",
} satisfies ConversationMessage;

describe("mergePendingInitialMessage", () => {
	test("prepends a pending message even when committed records exist", () => {
		expect(mergePendingInitialMessage([assistantMessage], userMessage)).toEqual(
			[userMessage, assistantMessage]
		);
	});

	test("does not duplicate a pending message already projected by records", () => {
		expect(
			mergePendingInitialMessage([userMessage, assistantMessage], userMessage)
		).toEqual([userMessage, assistantMessage]);
	});
});

describe("getMostRecentSession", () => {
	test("uses last message time instead of pinned session order", () => {
		const newest = getMostRecentSession([
			{
				createdAt: new Date("2026-07-01T00:00:00.000Z"),
				id: "older",
				lastMessageAt: new Date("2026-07-03T00:00:00.000Z"),
				pinned: true,
				title: "Older",
			},
			{
				createdAt: new Date("2026-07-02T00:00:00.000Z"),
				id: "newer",
				lastMessageAt: new Date("2026-07-04T00:00:00.000Z"),
				pinned: false,
				title: "Newer",
			},
		]);

		expect(newest?.id).toBe("newer");
	});
});
