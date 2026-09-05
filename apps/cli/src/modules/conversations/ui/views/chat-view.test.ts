import { describe, expect, test } from "bun:test";
import { canSubmitHomePrompt } from "./chat-view";

describe("canSubmitHomePrompt", () => {
	const readyState = {
		defaultAgentId: "build",
		initializedDefaultAgentId: "build",
		isCreatingSession: false,
		isPromptConfigRestored: true,
		registryReady: true,
	};

	test("blocks submit while last-message prompt config is loading", () => {
		expect(
			canSubmitHomePrompt({ ...readyState, isPromptConfigRestored: false })
		).toBe(false);
	});

	test("allows submit after prompt config and agent initialization", () => {
		expect(canSubmitHomePrompt(readyState)).toBe(true);
	});
});
