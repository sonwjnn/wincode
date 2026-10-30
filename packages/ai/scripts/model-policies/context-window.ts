import type { ProviderModel } from "../../src/sdk.ts";
import type { ProviderModelFamilyId } from "../model-families/types.ts";

const DEFAULT_CONTEXT_WINDOW_CAP_TOKENS = 272_000;

const DIRECT_PROVIDER_FAMILY_BY_ID: Readonly<
	Record<string, ProviderModelFamilyId>
> = {
	anthropic: "anthropic",
	deepseek: "deepseek",
	google: "google",
	openai: "openai",
};

const ROUTED_PROVIDER_FAMILIES: Readonly<
	Record<string, readonly ProviderModelFamilyId[]>
> = {
	"opencode-go": ["deepseek", "openai"],
};

/** Applies Wincode's conservative context default to explicitly classified models. */
export const applyWincodeContextWindowPolicy = (
	model: ProviderModel,
	modelFamily: ProviderModelFamilyId | undefined
): ProviderModel => {
	if (modelFamily === undefined) {
		return model;
	}

	const directFamily = DIRECT_PROVIDER_FAMILY_BY_ID[model.providerId];
	const routedFamilies = ROUTED_PROVIDER_FAMILIES[model.providerId];
	if (directFamily !== modelFamily && !routedFamilies?.includes(modelFamily)) {
		return model;
	}

	const contextWindowTokens = model.limits?.contextWindowTokens;
	if (
		contextWindowTokens === undefined ||
		contextWindowTokens <= DEFAULT_CONTEXT_WINDOW_CAP_TOKENS
	) {
		return model;
	}

	return {
		...model,
		limits: {
			...model.limits,
			contextWindowTokens: DEFAULT_CONTEXT_WINDOW_CAP_TOKENS,
		},
	};
};
