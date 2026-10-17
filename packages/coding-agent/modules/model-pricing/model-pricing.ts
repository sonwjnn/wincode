import type { ModelCost, ModelCostTier, ProviderModel } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";

/** Pricing copied from the exact Provider Model used by the Session. */
export type ModelPricingEntry = Readonly<{
	cost: ModelCost;
	tiers?: readonly ModelCostTier[];
}>;

/** Maps exact Provider Model prices into the shared usage-cost contract. */
export const pricingEntryForProviderModel = (
	model: ProviderModel
): ModelPricingEntry | undefined => {
	const pricing = model.pricing;
	const input = pricing?.inputPerMillionTokensUsd;
	const output = pricing?.outputPerMillionTokensUsd;
	if (pricing === undefined || input === undefined || output === undefined) {
		return;
	}
	return {
		cost: {
			input,
			output,
			...omitUndefined({
				cacheRead: pricing.cacheReadPerMillionTokensUsd,
				cacheWrite: pricing.cacheWritePerMillionTokensUsd,
			}),
		},
		...(pricing.tiers === undefined
			? {}
			: {
					tiers: pricing.tiers.map((tier) => ({
						inputTokensAbove: tier.inputTokensAbove,
						input: tier.inputPerMillionTokensUsd,
						output: tier.outputPerMillionTokensUsd,
						...omitUndefined({
							cacheRead: tier.cacheReadPerMillionTokensUsd,
							cacheWrite: tier.cacheWritePerMillionTokensUsd,
						}),
					})),
				}),
	};
};
