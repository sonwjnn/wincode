import { expect, test } from "bun:test";
import { defaultChatModelSelection } from "@wincode/ai/models";
import {
	catalogSelectionForProviderModel,
	normalizeProviderModelSelection,
	providerModelSelectionSchema,
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
