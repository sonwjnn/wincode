import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	type ModelCost,
	type ModelRuntimeProviderId,
} from "@wincode/ai";
import { billingPricebook } from "@wincode/billing";
import { z } from "zod";

export type ModelPricingEntry = {
	contextLimit: number;
	cost?: ModelCost;
};

export type ModelPricingTable = Readonly<Record<string, ModelPricingEntry>>;

const modelCostSchema = z
	.object({
		cacheRead: z.number().nonnegative().optional(),
		cacheWrite: z.number().nonnegative().optional(),
		input: z.number().nonnegative(),
		output: z.number().nonnegative(),
	})
	.strict() satisfies z.ZodType<ModelCost>;

/** Shared shape for both the on-disk cache and the live models.dev fetch result. */
export const modelPricingEntrySchema = z
	.object({
		contextLimit: z.number().int().positive(),
		cost: modelCostSchema.optional(),
	})
	.strict() satisfies z.ZodType<ModelPricingEntry>;

export const modelPricingTableSchema = z.record(
	z.string(),
	modelPricingEntrySchema
);

export const modelPricingKey = (
	provider: ModelRuntimeProviderId,
	modelId: string
): string => `${provider}/${modelId}`;

const MICROS_PER_MILLION = 1_000_000n;
const microsToUsdPerMillion = (micros: bigint): number =>
	Number(micros) / Number(MICROS_PER_MILLION);

/**
 * Hosted (`wincode`) prices come from the billing pricebook, because the price
 * we charge users is our margin, not the underlying provider's list price.
 */
export const getHostedModelCost = (modelId: string): ModelCost | undefined => {
	const entry =
		billingPricebook.models[modelId as keyof typeof billingPricebook.models];
	if (!entry) {
		return;
	}
	return {
		input: microsToUsdPerMillion(entry.inputMicrosPerMillionTokens),
		output: microsToUsdPerMillion(entry.outputMicrosPerMillionTokens),
		cacheRead: microsToUsdPerMillion(entry.cacheReadMicrosPerMillionTokens),
	};
};

/**
 * Resolves the pricing entry for a model selection. `null` when the model is
 * unknown to the catalog (the footer should hide in that case).
 */
export const resolveModelPricing = (
	table: ModelPricingTable,
	selection: ChatModelSelection
): ModelPricingEntry | null => {
	const model = findSupportedChatModelSelection(selection);
	if (!model) {
		return null;
	}
	const key = modelPricingKey(model.provider, model.id);
	const fromTable = table[key];
	if (!fromTable) {
		return null;
	}
	const cost =
		model.connectionProviderId === "wincode"
			? (getHostedModelCost(model.id) ?? fromTable.cost)
			: fromTable.cost;
	return { contextLimit: fromTable.contextLimit, ...(cost ? { cost } : {}) };
};
