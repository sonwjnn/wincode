import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	type ModelCost,
	type ModelRuntimeProviderId,
} from "@wincode/ai";
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
	const cost = fromTable.cost;
	return { contextLimit: fromTable.contextLimit, ...(cost ? { cost } : {}) };
};
