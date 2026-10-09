import { describe, expect, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai/models";
import {
	resolveInitialPromptThinkingSelection,
	updatePromptConfigModel,
	updatePromptConfigSelection,
} from "@/modules/prompt-settings/context/prompt-config-provider";
import { agentId, modelId } from "./support/identifiers";

const model = (
	id: string,
	providerId: ChatModelSelection["providerId"]
): ChatModelSelection => ({
	modelId: modelId(id),
	providerId,
});

describe("initial Prompt Configuration", () => {
	test("defaults to supported low ThinkingLevel", () => {
		expect(
			resolveInitialPromptThinkingSelection(
				model("gpt-5.6-luna", "openai"),
				undefined
			)
		).toEqual({ thinkingLevel: "low" });
	});

	test("defaults to low when a toggle-only model can express positive levels", () => {
		expect(
			resolveInitialPromptThinkingSelection(
				model("qwen3.7-max", "opencode-go"),
				undefined
			)
		).toEqual({ thinkingLevel: "low" });
	});

	test("preserves an explicitly selected supported ThinkingLevel", () => {
		expect(
			resolveInitialPromptThinkingSelection(
				model("gpt-5.6-luna", "openai"),
				"high"
			)
		).toEqual({ thinkingLevel: "high" });
	});
});

describe("updatePromptConfigModel", () => {
	test("keeps ThinkingLevel when the Model Target is unchanged", () => {
		const currentModel = model("gpt-5.6-luna", "openai");
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: currentModel,
					thinkingLevel: "high",
				},
				currentModel
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: currentModel,
			thinkingLevel: "high",
		});
	});

	test("preserves a supported ThinkingLevel when the selected model changes", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("gpt-5.6-luna", "openai"),
					thinkingLevel: "high",
				},
				model("claude-sonnet-5", "anthropic")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("claude-sonnet-5", "anthropic"),
			thinkingLevel: "high",
		});
	});

	test("clears a ThinkingLevel unsupported by the newly selected model", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("gpt-5.6-luna", "openai"),
					thinkingLevel: "high",
				},
				model("grok-4.6", "opencode-go")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("grok-4.6", "opencode-go"),
		});
	});
});

describe("updatePromptConfigSelection", () => {
	const modelTarget = model("qwen3.8-flash", "opencode-go");
	const base = {
		agent: agentId("code-reviewer"),
		model: modelTarget,
	};

	test("selecting a ThinkingLevel replaces the current value", () => {
		expect(
			updatePromptConfigSelection(
				{ ...base, thinkingLevel: "low" },
				{ thinkingLevel: "xhigh" }
			)
		).toEqual({ ...base, thinkingLevel: "xhigh" });
	});

	test("normalizes an unsupported selected ThinkingLevel to provider default", () => {
		expect(
			updatePromptConfigSelection(
				{ ...base, thinkingLevel: "xhigh" },
				{ thinkingLevel: "max" }
			)
		).toEqual(base);
	});
});
