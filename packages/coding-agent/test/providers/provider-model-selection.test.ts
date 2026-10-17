import { expect, test } from "bun:test";
import { toModelId } from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai";
import {
	arePluginProviderRegistrationsBoundToTrustedOwners,
	DEFAULT_PROVIDER_MODEL_SELECTION,
	isAvailableProviderModelSelection,
	isPluginProviderSelectionBoundToTrustedOwner,
	isSameProviderModelIdentity,
	normalizeProviderModelSelection,
	normalizeProviderModelThinkingSelection,
	providerModelReasoningEffort,
	providerModelSelectionForProviderModel,
	providerModelSelectionSchema,
	resolveProviderModelSelectionForHost,
	supportedProviderThinkingLevels,
} from "@/modules/providers/provider-model-selection";

test("the global default remains the OpenAI gpt-5.6-luna Provider Model", () => {
	expect(DEFAULT_PROVIDER_MODEL_SELECTION).toEqual({
		modelId: toModelId("gpt-5.6-luna"),
		providerId: "openai",
	});
});

test("Provider Model selections preserve exact identities without accepting empty IDs", () => {
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
			legacyAlias: "openai",
		}).success
	).toBe(false);
	const pluginOwner = {
		pluginId: "trusted-plugin",
		sourceIdentity: "/trusted/plugins/provider.ts",
	};
	const sourceBound = normalizeProviderModelSelection({
		...openRouterModel,
		pluginProviderSource: pluginOwner,
	});
	if (sourceBound === null) {
		throw new Error("The source-bound Provider Model should parse.");
	}
	expect(sourceBound.pluginProviderSource).toEqual(pluginOwner);
	expect(
		providerModelSelectionForProviderModel(openRouterModel, pluginOwner)
	).toEqual(sourceBound);
	expect(
		providerModelSelectionSchema.safeParse({
			...openRouterModel,
			pluginProviderSource: { ...pluginOwner, sourceIdentity: "" },
		}).success
	).toBe(false);
});

test("Provider Model identity comparison ignores Plugin ownership metadata", () => {
	const selection = {
		modelId: "plugin-model",
		pluginProviderSource: {
			pluginId: "plugin-a",
			sourceIdentity: "/plugins/a.ts",
		},
		providerId: "plugin-provider",
	};
	const sameIdentityDifferentOwner = {
		modelId: "plugin-model",
		pluginProviderSource: {
			pluginId: "plugin-b",
			sourceIdentity: "/plugins/b.ts",
		},
		providerId: "plugin-provider",
	};

	expect(
		isSameProviderModelIdentity(selection, sameIdentityDifferentOwner)
	).toBe(true);
	expect(
		isSameProviderModelIdentity(selection, {
			...sameIdentityDifferentOwner,
			modelId: "different-model",
		})
	).toBe(false);
});

test("Host collection registration snapshots must exactly match current trusted Plugin Providers", () => {
	const owner = {
		pluginId: "trusted-plugin",
		providerId: "custom-provider",
		sourceIdentity: "/trusted/plugins/provider.ts",
	};

	expect(
		arePluginProviderRegistrationsBoundToTrustedOwners([owner], [owner])
	).toBe(true);
	expect(
		arePluginProviderRegistrationsBoundToTrustedOwners([owner], undefined)
	).toBe(false);
	expect(arePluginProviderRegistrationsBoundToTrustedOwners([owner], [])).toBe(
		false
	);
	expect(
		arePluginProviderRegistrationsBoundToTrustedOwners(
			[owner],
			[{ ...owner, sourceIdentity: "/plugins/colliding-provider.ts" }]
		)
	).toBe(false);
	expect(
		arePluginProviderRegistrationsBoundToTrustedOwners([owner], [owner, owner])
	).toBe(false);
	expect(arePluginProviderRegistrationsBoundToTrustedOwners([], [])).toBe(true);
});

test("Host preflight binds only fresh Plugin selections and rejects historical ownerless models", () => {
	const model = normalizeProviderModelSelection({
		modelId: "plugin-model",
		providerId: "custom-provider",
	});
	if (model === null) {
		throw new Error("The Provider Model identity should parse.");
	}
	const trustedRegistration = {
		pluginId: "trusted-plugin",
		providerId: "custom-provider",
		sourceIdentity: "/trusted/plugins/provider.ts",
	};

	expect(() =>
		resolveProviderModelSelectionForHost(model, [trustedRegistration])
	).toThrow("re-select it in Interactive Mode");
	const fresh = resolveProviderModelSelectionForHost(
		model,
		[trustedRegistration],
		true
	);
	expect(fresh?.pluginProviderSource).toEqual({
		pluginId: trustedRegistration.pluginId,
		sourceIdentity: trustedRegistration.sourceIdentity,
	});
	expect(() =>
		resolveProviderModelSelectionForHost(
			model,
			[trustedRegistration, trustedRegistration],
			true
		)
	).toThrow("re-select it in Interactive Mode");
	expect(() =>
		resolveProviderModelSelectionForHost(
			{
				...model,
				pluginProviderSource: {
					pluginId: "trusted-plugin",
					sourceIdentity: "/trusted/plugins/previous-provider.ts",
				},
			},
			[trustedRegistration],
			true
		)
	).toThrow("re-select it in Interactive Mode");
	expect(
		resolveProviderModelSelectionForHost(
			normalizeProviderModelSelection({
				modelId: "gpt-5.6",
				providerId: "openai",
			}) ?? model,
			[]
		)
	).toMatchObject({ providerId: "openai", modelId: "gpt-5.6" });
});

test("custom Plugin selections require the Host collection to confirm their trusted owner", () => {
	const owner = {
		pluginId: "trusted-plugin",
		providerId: "custom-provider",
		sourceIdentity: "/trusted/plugins/provider.ts",
	};
	const selected = {
		modelId: toModelId("plugin-model"),
		pluginProviderSource: {
			pluginId: owner.pluginId,
			sourceIdentity: owner.sourceIdentity,
		},
		providerId: owner.providerId,
	};

	expect(isPluginProviderSelectionBoundToTrustedOwner(selected, [owner])).toBe(
		false
	);
	expect(
		isPluginProviderSelectionBoundToTrustedOwner(selected, [owner], [])
	).toBe(false);
	expect(
		isPluginProviderSelectionBoundToTrustedOwner(selected, [owner], [owner])
	).toBe(true);
	expect(
		isPluginProviderSelectionBoundToTrustedOwner(
			selected,
			[owner],
			[{ ...owner, pluginId: "colliding-plugin" }]
		)
	).toBe(false);
	expect(
		isPluginProviderSelectionBoundToTrustedOwner(
			selected,
			[owner],
			[owner, owner]
		)
	).toBe(false);
	expect(
		isPluginProviderSelectionBoundToTrustedOwner(
			{ modelId: toModelId("gpt-5.6"), providerId: "openai" },
			[]
		)
	).toBe(true);
	expect(
		isPluginProviderSelectionBoundToTrustedOwner(
			{ modelId: toModelId("plugin-model"), providerId: "custom-provider" },
			[]
		)
	).toBe(false);
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
