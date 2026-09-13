import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	getModelMetadata,
	type ModelRuntimeProviderId,
} from "@wincode/ai/models";
import type { ModelMetadataEntry } from "@wincode/ai/models-dev";

/**
 * A runtime override table over the generated catalog metadata. Both sides are
 * models.dev-derived, so the entry shape they share is `ModelMetadataEntry`;
 * a live table only ever carries more current values.
 */
export type ModelPricingEntry = ModelMetadataEntry;

export type ModelPricingTable = Readonly<Record<string, ModelPricingEntry>>;

/**
 * How current the rates behind a resolved price are. `"bundled"` is the
 * snapshot compiled into the build; `"cache"` is a previously fetched table
 * still inside its TTL; `"stale"` is one past it. The distinction is worth
 * showing because published rates move — measured over one 35-day window,
 * 8 of 66 catalog models changed price, the largest by 507%.
 */
export type ModelPricingSource = "bundled" | "cache" | "stale";

export const modelPricingKey = (
	provider: ModelRuntimeProviderId,
	modelId: string
): string => `${provider}/${modelId}`;

const mergeModelCost = (
	catalog: ModelMetadataEntry["cost"],
	live: ModelMetadataEntry["cost"]
): ModelMetadataEntry["cost"] => {
	if (!catalog) {
		return live;
	}
	if (!live) {
		return catalog;
	}
	const cacheRead = live.cacheRead ?? catalog.cacheRead;
	const cacheWrite = live.cacheWrite ?? catalog.cacheWrite;
	return {
		input: live.input ?? catalog.input,
		output: live.output ?? catalog.output,
		...(cacheRead === undefined ? {} : { cacheRead }),
		...(cacheWrite === undefined ? {} : { cacheWrite }),
	};
};

const mergeModelLimits = (
	catalog: ModelMetadataEntry["limits"],
	live: ModelMetadataEntry["limits"]
): ModelMetadataEntry["limits"] => {
	if (!catalog) {
		return live;
	}
	if (!live) {
		return catalog;
	}
	return {
		context: live.context ?? catalog.context,
		...((live.output ?? catalog.output)
			? { output: live.output ?? catalog.output }
			: {}),
	};
};

/**
 * Resolves the metadata for a model selection. The Model Catalog is the base:
 * its generated snapshot covers every active entry, so a context limit no
 * longer depends on a successful fetch. A live models.dev table overrides the
 * fields it actually carries, which is the whole point of refreshing it.
 */
export const resolveModelMetadata = (
	table: ModelPricingTable,
	selection: ChatModelSelection
): ModelMetadataEntry | null => {
	const model = findSupportedChatModelSelection(selection);
	if (!model) {
		return null;
	}
	const catalog = getModelMetadata(model);
	const live = table[modelPricingKey(model.provider, model.id)];
	const cost = mergeModelCost(catalog?.cost, live?.cost);
	const limits = mergeModelLimits(catalog?.limits, live?.limits);
	const thinking =
		catalog?.thinking || live?.thinking
			? { ...catalog?.thinking, ...live?.thinking }
			: undefined;
	const merged: ModelMetadataEntry = {
		...catalog,
		...live,
		...(cost ? { cost } : {}),
		...(limits ? { limits } : {}),
		...(thinking ? { thinking } : {}),
	};
	return Object.keys(merged).length === 0 ? null : merged;
};

/**
 * Context limit for a selection, or `null` when the model is unknown to the
 * catalog or the snapshot carried no limit for it.
 */
export const resolveModelContextLimit = (
	table: ModelPricingTable,
	selection: ChatModelSelection
): number | null =>
	resolveModelMetadata(table, selection)?.limits?.context ?? null;
