import { describe, expect, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai/models";
import {
	resolveInitialPromptReasoningSelection,
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
	test("defaults to the supported low Effort", () => {
		expect(
			resolveInitialPromptReasoningSelection(
				model("gpt-5.6-luna", "openai"),
				undefined,
				undefined
			)
		).toEqual({ effort: "low" });
	});

	test("leaves Effort unset when low is unavailable", () => {
		expect(
			resolveInitialPromptReasoningSelection(
				model("qwen3.7-max", "opencode-go"),
				undefined,
				undefined
			)
		).toEqual({});
	});

	test("preserves a supported initial Reasoning Mode", () => {
		expect(
			resolveInitialPromptReasoningSelection(
				model("qwen3.7-max", "opencode-go"),
				undefined,
				"thinking"
			)
		).toEqual({ reasoningMode: "thinking" });
	});
});

describe("updatePromptConfigModel", () => {
	test("keeps an Effort when the Model Target is unchanged", () => {
		const currentModel = model("gpt-5.6-luna", "openai");
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: currentModel,
					effort: "high",
				},
				currentModel
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: currentModel,
			effort: "high",
		});
	});

	test("preserves a supported Effort when the selected model changes", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("gpt-5.6-luna", "openai"),
					effort: "low",
				},
				model("claude-sonnet-5", "anthropic")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("claude-sonnet-5", "anthropic"),
			effort: "low",
		});
	});

	test("clears an Effort unsupported by the newly selected model", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("gpt-5.6-luna", "openai"),
					effort: "high",
				},
				model("qwen3.7-max", "opencode-go")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("qwen3.7-max", "opencode-go"),
		});
	});

	test("preserves a supported Reasoning Mode when the model changes", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("qwen3.7-max", "opencode-go"),
					reasoningMode: "thinking",
				},
				model("qwen3.7-plus", "opencode-go")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("qwen3.7-plus", "opencode-go"),
			reasoningMode: "thinking",
		});
	});

	test("clears a Reasoning Mode unsupported by the newly selected model", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("qwen3.7-max", "opencode-go"),
					reasoningMode: "thinking",
				},
				model("gpt-5.6-luna", "openai")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("gpt-5.6-luna", "openai"),
		});
	});
});

describe("updatePromptConfigSelection", () => {
	const modelTarget = model("qwen3.8-flash", "opencode-go");
	const base = {
		agent: agentId("code-reviewer"),
		model: modelTarget,
	};

	test("selecting an Effort clears the active Reasoning Mode", () => {
		expect(
			updatePromptConfigSelection(
				{ ...base, reasoningMode: "none" },
				{ effort: "xhigh" }
			)
		).toEqual({ ...base, effort: "xhigh" });
	});

	test("selecting a Reasoning Mode clears the active Effort", () => {
		expect(
			updatePromptConfigSelection(
				{ ...base, effort: "xhigh" },
				{ reasoningMode: "none" }
			)
		).toEqual({ ...base, reasoningMode: "none" });
	});

	test("rejects a choice unavailable for the selected model", () => {
		expect(
			updatePromptConfigSelection(
				{ ...base, effort: "xhigh" },
				{ reasoningMode: "thinking" }
			)
		).toEqual(base);
	});
});
