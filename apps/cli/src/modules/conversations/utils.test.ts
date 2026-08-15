import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";

const { getMostRecentSession, shouldAutoStartAssistantTurn } = await import(
	"./utils"
);

const userMessage = {
	id: "user-1",
	parts: [{ text: "hello", type: "text" }],
	role: "user",
} satisfies CodingAgentUIMessage;

const assistantMessage = {
	id: "assistant-1",
	parts: [{ text: "hi", type: "text" }],
	role: "assistant",
} satisfies CodingAgentUIMessage;

describe("shouldAutoStartAssistantTurn", () => {
	test("starts the first assistant turn for a freshly created session", () => {
		expect(shouldAutoStartAssistantTurn(true, "", userMessage)).toBe(true);
	});

	test("does not auto-start when opening an existing session from the dialog", () => {
		expect(shouldAutoStartAssistantTurn(false, "", userMessage)).toBe(false);
	});

	test("does not auto-start when the last message is from the assistant", () => {
		expect(shouldAutoStartAssistantTurn(true, "", assistantMessage)).toBe(
			false
		);
	});

	test("does not auto-start when an initial prompt will be submitted instead", () => {
		expect(shouldAutoStartAssistantTurn(true, "hello", userMessage)).toBe(
			false
		);
	});

	test("does not auto-start when there are no messages", () => {
		expect(shouldAutoStartAssistantTurn(true, "", undefined)).toBe(false);
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
