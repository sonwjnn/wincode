import { expect, test } from "bun:test";
import { defaultChatModelSelection } from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import {
	catalogSelectionForProviderModel,
	isAvailableProviderModelSelection,
	normalizeProviderModelSelection,
	normalizeProviderModelThinkingSelection,
	providerModelReasoningEffort,
	providerModelSelectionSchema,
	supportedProviderThinkingLevels,
} from "@/modules/providers/provider-model-selection";

test("Provider Model selections preserve exact unknown provider identities without accepting empty IDs", () => {
	const openRouterModel = {
		modelId: "vendor/example-model",
		providerId: "openrouter",
	};

	const parsedOpenRouterModel =
		providerModelSelectionSchema.parse(openRouterModel);
	expect(String(parsedOpenRouterModel.modelId)).toBe("vendor/example-model");
	expect(parsedOpenRouterModel.providerId).toBe("openrouter");
	expect(
		normalizeProviderModelSelection({ modelId: "", providerId: "openrouter" })
	).toBeNull();
	expect(
		providerModelSelectionSchema.safeParse({
			...openRouterModel,
			catalogAlias: "openai",
		}).success
	).toBe(false);
	expect(catalogSelectionForProviderModel(parsedOpenRouterModel)).toBeNull();
	expect(catalogSelectionForProviderModel(defaultChatModelSelection)).toEqual(
		defaultChatModelSelection
	);
});

test("Home rejects a stored model unless that exact Provider Model is currently available", () => {
	const stored = normalizeProviderModelSelection({
		modelId: "gpt-5.6",
		providerId: "openai",
	});
	const available = [
		{
			modelId: "gpt-5.6",
			protocolId: "openai-responses",
			providerId: "openai",
		},
	];
	const wrongModel = normalizeProviderModelSelection({
		modelId: "gpt-4o",
		providerId: "openai",
	});
	const wrongProvider = normalizeProviderModelSelection({
		modelId: "gpt-5.6",
		providerId: "plugin-provider",
	});
	if (stored === null || wrongModel === null || wrongProvider === null) {
		throw new Error("The Provider Model identities should parse.");
	}

	expect(isAvailableProviderModelSelection(stored, available)).toBe(true);
	expect(isAvailableProviderModelSelection(wrongModel, available)).toBe(false);
	expect(isAvailableProviderModelSelection(wrongProvider, available)).toBe(
		false
	);
});

test("Provider Thinking options expose only declared reasoning efforts", () => {
	const model: ProviderModel = {
		modelId: "reasoning-model",
		protocolId: "fixture",
		providerId: "fixture",
		reasoningEfforts: ["none", "high"],
	};
	const undeclared: ProviderModel = {
		modelId: "plain-model",
		protocolId: "fixture",
		providerId: "fixture",
	};

	expect(supportedProviderThinkingLevels(model)).toEqual(["off", "high"]);
	expect(providerModelReasoningEffort(model, "high")).toBe("high");
	expect(providerModelReasoningEffort(model, "off")).toBe("none");
	expect(providerModelReasoningEffort(model, "medium")).toBeUndefined();
	expect(
		normalizeProviderModelThinkingSelection(model, {
			thinkingLevel: "off",
		})
	).toEqual({ thinkingLevel: "off" });
	expect(
		normalizeProviderModelThinkingSelection(model, {
			thinkingLevel: "medium",
		})
	).toEqual({});
	expect(supportedProviderThinkingLevels(undeclared)).toEqual([]);
});
