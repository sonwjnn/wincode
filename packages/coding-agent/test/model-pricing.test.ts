import { expect, test } from "bun:test";
import type { ProviderModel } from "@wincode/ai";
import { pricingEntryForProviderModel } from "@/modules/model-pricing/model-pricing";

test("Provider Model pricing is reported directly from SDK metadata", () => {
	const model: ProviderModel = {
		modelId: "vendor/current-model",
		pricing: {
			cacheReadPerMillionTokensUsd: 0.02,
			cacheWritePerMillionTokensUsd: 0.25,
			inputPerMillionTokensUsd: 0.3,
			outputPerMillionTokensUsd: 2,
			tiers: [
				{
					inputTokensAbove: 200_000,
					inputPerMillionTokensUsd: 0.45,
					outputPerMillionTokensUsd: 2.5,
				},
			],
		},
		protocolId: "test",
		providerId: "plugin-provider",
	};

	expect(pricingEntryForProviderModel(model)).toEqual({
		cost: {
			cacheRead: 0.02,
			cacheWrite: 0.25,
			input: 0.3,
			output: 2,
		},
		tiers: [
			{
				inputTokensAbove: 200_000,
				input: 0.45,
				output: 2.5,
			},
		],
	});
	expect(
		pricingEntryForProviderModel({
			modelId: model.modelId,
			protocolId: model.protocolId,
			providerId: model.providerId,
		})
	).toBeUndefined();
});
