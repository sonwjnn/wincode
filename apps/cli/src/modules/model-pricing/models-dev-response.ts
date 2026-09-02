import type { ModelRuntimeProviderId } from "@wincode/ai/models";
import { z } from "zod";
import {
	type ModelPricingEntry,
	type ModelPricingTable,
	modelPricingEntrySchema,
	modelPricingKey,
} from "./model-pricing";

const runtimeProviderIds: Readonly<Record<ModelRuntimeProviderId, true>> = {
	anthropic: true,
	google: true,
	openai: true,
	"opencode-go": true,
};
const isModelRuntimeProviderId = (
	value: string
): value is ModelRuntimeProviderId =>
	runtimeProviderIds[value as ModelRuntimeProviderId] === true;

const modelsDevLimitSchema = z
	.object({
		context: z.number().int().positive(),
	})
	.partial()
	.optional();

const modelsDevCostSchema = z
	.object({
		cache_read: z.number().nonnegative().optional(),
		cache_write: z.number().nonnegative().optional(),
		input: z.number().nonnegative(),
		output: z.number().nonnegative(),
	})
	.optional();

const modelsDevEntrySchema = z
	.object({
		cost: modelsDevCostSchema,
		limit: modelsDevLimitSchema,
	})
	.partial();

const modelsDevProviderSchema = z.object({
	models: z.record(z.string(), z.unknown()),
});

const modelsDevResponseSchema = z.record(z.string(), modelsDevProviderSchema);

const toModelCost = (
	cost: NonNullable<z.infer<typeof modelsDevCostSchema>>
): NonNullable<ModelPricingEntry["cost"]> => {
	const next: NonNullable<ModelPricingEntry["cost"]> = {
		input: cost.input,
		output: cost.output,
	};
	if (cost.cache_read !== undefined) {
		next.cacheRead = cost.cache_read;
	}
	if (cost.cache_write !== undefined) {
		next.cacheWrite = cost.cache_write;
	}
	return next;
};

/** Parses and validates a single models.dev model entry, or `null` if unusable. */
const parseModelsDevEntry = (rawEntry: unknown): ModelPricingEntry | null => {
	const entry = modelsDevEntrySchema.safeParse(rawEntry);
	if (!entry.success) {
		return null;
	}
	const context = entry.data.limit?.context;
	if (context === undefined) {
		return null;
	}
	const next: ModelPricingEntry = {
		contextLimit: context,
		...(entry.data.cost ? { cost: toModelCost(entry.data.cost) } : {}),
	};
	const validated = modelPricingEntrySchema.safeParse(next);
	return validated.success ? validated.data : null;
};

/**
 * Parses the raw `https://models.dev/api.json` payload into a pricing table
 * keyed by `${provider}/${modelId}`. Only the three runtime providers we
 * actually route to are kept — models.dev also lists ~170 resellers whose
 * prices don't apply here and would otherwise bloat the table with keys we
 * never look up. Entries that fail to parse or lack `limit.context` are
 * silently dropped — one bad model must not break the rest of the table.
 */
export const buildModelPricingTable = (
	raw: unknown,
	ids: ReadonlySet<string>
): ModelPricingTable => {
	const parsed = modelsDevResponseSchema.safeParse(raw);
	if (!parsed.success) {
		return {};
	}
	const table: Record<string, ModelPricingEntry> = {};
	for (const [provider, providerBlock] of Object.entries(parsed.data)) {
		if (!isModelRuntimeProviderId(provider)) {
			continue;
		}
		for (const [modelId, rawEntry] of Object.entries(providerBlock.models)) {
			if (!ids.has(modelId)) {
				continue;
			}
			const entry = parseModelsDevEntry(rawEntry);
			if (entry) {
				table[modelPricingKey(provider, modelId)] = entry;
			}
		}
	}
	return table;
};
