import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import {
	getLatestChatConfig,
	getMostRecentSession,
	shouldAutoStartAssistantTurn,
} from "./utils";

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

describe("getLatestChatConfig", () => {
	test("returns metadata from the latest configured turn", () => {
		const messages = [
			{
				id: "user-1",
				metadata: {
					mode: "plan",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				},
				parts: [{ text: "first", type: "text" }],
				role: "user",
			},
			{
				id: "assistant-1",
				metadata: {
					mode: "build",
					model: { modelId: "gpt-5.5", providerId: "openai" },
				},
				parts: [{ text: "latest", type: "text" }],
				role: "assistant",
			},
		] satisfies CodingAgentUIMessage[];

		expect(getLatestChatConfig(messages)).toEqual({
			mode: "build",
			model: { modelId: "gpt-5.5", providerId: "openai" },
		});
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
