import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { shouldAutoStartAssistantTurn } from "./utils";

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
