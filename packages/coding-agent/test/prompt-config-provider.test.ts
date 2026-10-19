import { describe, expect, test } from "bun:test";
import type { ProviderModel, ThinkingLevel } from "@wincode/ai";
import type { AgentSelectionOverride } from "@/modules/agents";
import {
	nextThinkingLevelInCycle,
	resolveInitialPromptThinkingSelection,
	updatePromptConfigModel,
	updatePromptConfigModelOverride,
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
	const agent = agentId("code-reviewer");
	const currentModel = model("gpt-5.6-luna", "openai");
	const current = {
		agent,
		model: currentModel,
		thinkingLevel: "high" as const,
	};

	test("resets to low when the newly selected Provider Model supports it", () => {
		const nextModel = model("claude-sonnet-5", "anthropic");
		const providerModel: ProviderModel = {
			modelId: nextModel.modelId,
			protocolId: "fixture",
			providerId: nextModel.providerId,
			reasoningEfforts: ["low", "high"],
		};

		expect(updatePromptConfigModel(current, nextModel, providerModel)).toEqual({
			...current,
			model: nextModel,
			thinkingLevel: "low",
		});
	});

	test("uses a higher-first fallback when the new model does not support low", () => {
		const nextModel = model("claude-sonnet-5", "anthropic");
		const providerModel: ProviderModel = {
			modelId: nextModel.modelId,
			protocolId: "fixture",
			providerId: nextModel.providerId,
			reasoningEfforts: ["off", "minimal", "medium"],
		};

		expect(updatePromptConfigModel(current, nextModel, providerModel)).toEqual({
			...current,
			model: nextModel,
			thinkingLevel: "medium",
		});
	});

	test("falls back to the closest lower supported level when no higher level exists", () => {
		const nextModel = model("claude-sonnet-5", "anthropic");
		const providerModel: ProviderModel = {
			modelId: nextModel.modelId,
			protocolId: "fixture",
			providerId: nextModel.providerId,
			reasoningEfforts: ["off", "minimal"],
		};

		expect(updatePromptConfigModel(current, nextModel, providerModel)).toEqual({
			...current,
			model: nextModel,
			thinkingLevel: "minimal",
		});
	});

	test("uses explicit Off only when it is the sole supported fallback", () => {
		const nextModel = model("claude-sonnet-5", "anthropic");
		const providerModel: ProviderModel = {
			modelId: nextModel.modelId,
			protocolId: "fixture",
			providerId: nextModel.providerId,
			reasoningEfforts: ["off"],
		};

		expect(updatePromptConfigModel(current, nextModel, providerModel)).toEqual({
			...current,
			model: nextModel,
			thinkingLevel: "off",
		});
	});

	test("does not choose an undeclared effort when the model supports none", () => {
		const nextModel = model("plain-model", "anthropic");
		const providerModel: ProviderModel = {
			modelId: nextModel.modelId,
			protocolId: "fixture",
			providerId: nextModel.providerId,
		};

		expect(updatePromptConfigModel(current, nextModel, providerModel)).toEqual({
			agent,
			model: nextModel,
		});
	});

	test("reselecting the same Provider Model preserves its current ThinkingLevel", () => {
		const providerModel: ProviderModel = {
			modelId: currentModel.modelId,
			protocolId: "fixture",
			providerId: currentModel.providerId,
			reasoningEfforts: ["low", "high"],
		};

		expect(
			updatePromptConfigModel(current, currentModel, providerModel)
		).toEqual(current);
	});

	test("resets the submission override to the new model's resolved level", () => {
		const nextModel = model("claude-sonnet-5", "anthropic");
		const providerModel: ProviderModel = {
			modelId: nextModel.modelId,
			protocolId: "fixture",
			providerId: nextModel.providerId,
			reasoningEfforts: ["off", "medium"],
		};
		const currentOverride: AgentSelectionOverride = {
			model: currentModel,
			thinking: { thinkingLevel: "high" },
		};

		expect(
			updatePromptConfigModelOverride(
				currentOverride,
				currentModel,
				nextModel,
				providerModel
			)
		).toEqual({ model: nextModel, thinking: { thinkingLevel: "medium" } });
	});
});

describe("nextThinkingLevelInCycle", () => {
	test("cycles only explicit levels and starts with Off when available", () => {
		expect(nextThinkingLevelInCycle(undefined, ["off", "low"])).toBe("off");
		expect(nextThinkingLevelInCycle("off", ["off", "low"])).toBe("low");
		expect(nextThinkingLevelInCycle("low", ["off", "low"])).toBe("off");
	});

	test("does not invent a cycle value when the model has no supported levels", () => {
		expect(nextThinkingLevelInCycle(undefined, [])).toBeUndefined();
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
