import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@wincode/ai/sdk";
import {
	resolveInitialPromptThinkingSelection,
	updatePromptConfigModel,
	updatePromptConfigSelection,
} from "@/modules/prompt-settings/context/prompt-config-provider";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { agentId, modelId } from "./support/identifiers";

const model = (id: string, providerId: string): ProviderModelSelection => ({
	modelId: modelId(id),
	providerId,
});

describe("initial Prompt Configuration", () => {
	test("leaves the Provider-owned ThinkingLevel unset by default", () => {
		expect(resolveInitialPromptThinkingSelection(undefined)).toEqual({});
	});

	test("preserves an explicitly selected ThinkingLevel", () => {
		expect(resolveInitialPromptThinkingSelection("high")).toEqual({
			thinkingLevel: "high",
		});
	});
});

describe("updatePromptConfigModel", () => {
	test("preserves the selected ThinkingLevel when exact Provider identity changes", () => {
		const currentModel = model("gpt-5.6-luna", "openai");
		const nextModel = model("claude-sonnet-5", "anthropic");

		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: currentModel,
					thinkingLevel: "high",
				},
				nextModel
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: nextModel,
			thinkingLevel: "high",
		});
	});
});

describe("updatePromptConfigSelection", () => {
	const base = {
		agent: agentId("code-reviewer"),
		model: model("qwen3.8-flash", "opencode-go"),
	};

	test("selecting a ThinkingLevel replaces the current value", () => {
		expect(
			updatePromptConfigSelection(
				{ ...base, thinkingLevel: "low" },
				{ thinkingLevel: "xhigh" }
			)
		).toEqual({ ...base, thinkingLevel: "xhigh" });
	});

	test("clearing the selected ThinkingLevel leaves it to the Provider default", () => {
		const current: typeof base & { thinkingLevel?: ThinkingLevel } = {
			...base,
			thinkingLevel: "high",
		};
		expect(updatePromptConfigSelection(current, {})).toEqual(base);
	});
});
