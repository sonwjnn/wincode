// The single models.dev -> Wincode metadata converter. Both the offline
// generator (`scripts/sync-model-metadata.ts`) and the runtime pricing refresh
// call this, so a fact can only ever be interpreted one way. See ADR-0014.
//
// This module MUST NOT import `./generated/*`. The generator imports it, so a
// generated import here would close a cycle and break regeneration from a clean
// tree. The read path over the generated snapshot lives in
// `./model-metadata-snapshot`.

import {
	type ModelCost,
	type ModelCostTier,
	type ModelLimits,
	type ModelMetadataEntry,
	type ModelThinkingPolicy,
	type ModelVariant,
	modelVariantIds,
} from "./model-metadata";

import {
	type ModelsDevModel,
	modelsDevBlocksFromPayload,
} from "./models-dev-payload";
import { isRecord } from "./type-guards";

export type {
	ModelCost,
	ModelCostTier,
	ModelLimits,
	ModelMetadataEntry,
	ModelThinkingPolicy,
	ModelVariant,
} from "./model-metadata";
export { modelMetadataEntrySchema } from "./model-metadata";
export type { ModelsDevModel } from "./models-dev-payload";

const parseReasoningOptions = (
	value: unknown
): readonly Record<string, unknown>[] | undefined =>
	Array.isArray(value)
		? value.filter((option): option is Record<string, unknown> =>
				isRecord(option)
			)
		: undefined;

const nonNegativeNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;

const nonNegativeInteger = (value: unknown): number | undefined => {
	const number = nonNegativeNumber(value);
	return number !== undefined && Number.isInteger(number) ? number : undefined;
};

const positiveInteger = (value: unknown): number | undefined => {
	const number = nonNegativeInteger(value);
	return number !== undefined && number > 0 ? number : undefined;
};

const LEVEL_IDS: ReadonlySet<string> = new Set(modelVariantIds);

const asLevels = (value: unknown): readonly ModelVariant[] | undefined => {
	if (!Array.isArray(value)) {
		return;
	}
	// The catalog speaks a closed set of level identifiers. Upstream effort
	// values outside it are dropped rather than emitted as an unusable level.
	const levels = value.filter(
		(level): level is ModelVariant =>
			typeof level === "string" && LEVEL_IDS.has(level)
	);
	return levels.length === 0 ? undefined : levels;
};

const toThinkingPolicy = (raw: unknown): ModelThinkingPolicy | undefined => {
	const options = parseReasoningOptions(raw);
	if (!options) {
		return;
	}
	const effort = options.find((option) => option.type === "effort");
	const budget = options.find((option) => option.type === "budget_tokens");
	const toggle = options.find((option) => option.type === "toggle");
	const levels = asLevels(effort?.values);
	const budgetMin = nonNegativeInteger(budget?.min);
	const budgetMax = nonNegativeInteger(budget?.max);
	const budgetBounded = budgetMin !== undefined || budgetMax !== undefined;
	// A published budget range is a reasoning control even with no ladder: it
	// says how much thinking the model may do. With no switch and no ladder the
	// user has nothing to pick, so the model gets no selectable level and its
	// budget is derived rather than chosen. Without recording this, Claude 4.5
	// would look like a model with no reasoning control at all.
	const switchable = toggle !== undefined || budgetBounded;
	if (!(switchable || levels)) {
		return;
	}
	return {
		...(toggle ? { toggle: true as const } : {}),
		...(levels ? { levels } : {}),
		...(budgetMin === undefined ? {} : { budgetMin }),
		...(budgetMax === undefined ? {} : { budgetMax }),
		...(budgetBounded && !toggle && !levels
			? { unlevelled: true as const }
			: {}),
	};
};

const toCost = (raw: unknown): ModelCost | undefined => {
	if (!isRecord(raw)) {
		return;
	}
	const input = nonNegativeNumber(raw.input);
	const output = nonNegativeNumber(raw.output);
	if (input === undefined || output === undefined) {
		return;
	}
	const cacheRead = nonNegativeNumber(raw.cache_read);
	const cacheWrite = nonNegativeNumber(raw.cache_write);
	return {
		input,
		output,
		...(cacheRead === undefined ? {} : { cacheRead }),
		...(cacheWrite === undefined ? {} : { cacheWrite }),
	};
};

const CONTEXT_OVER_200K_THRESHOLD = 200_000;

/**
 * `context_over_200k` is a tier at a fixed threshold, not a second concept.
 * Folding it in here keeps the cost model single-shaped.
 */
const toTiers = (raw: unknown): readonly ModelCostTier[] => {
	if (!isRecord(raw)) {
		return [];
	}
	const tiers = Array.isArray(raw.tiers) ? raw.tiers : [];
	const parsed: ModelCostTier[] = [];
	for (const tier of tiers) {
		if (!isRecord(tier)) {
			continue;
		}
		const threshold = isRecord(tier.tier) ? tier.tier : undefined;
		const size = positiveInteger(threshold?.size);
		const rates = toCost(tier);
		if (size === undefined || !rates) {
			continue;
		}
		parsed.push({ inputTokensAbove: size, ...rates });
	}
	const over = toCost(raw.context_over_200k);
	if (over) {
		parsed.push({
			inputTokensAbove: CONTEXT_OVER_200K_THRESHOLD,
			...over,
		});
	}
	return parsed.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
};

const toLimits = (raw: unknown): ModelLimits | undefined => {
	if (!isRecord(raw)) {
		return;
	}
	const context = positiveInteger(raw.context);
	if (context === undefined) {
		return;
	}
	const output = positiveInteger(raw.output);
	return { context, ...(output === undefined ? {} : { output }) };
};

export const metadataForModel = (raw: ModelsDevModel): ModelMetadataEntry => {
	const thinking = toThinkingPolicy(raw.reasoning_options);
	const cost = toCost(raw.cost);
	const limits = toLimits(raw.limit);
	const tiers = toTiers(raw.cost);
	return {
		...(cost ? { cost } : {}),
		...(limits ? { limits } : {}),
		...(thinking ? { thinking } : {}),
		...(tiers.length === 0 ? {} : { tiers }),
	};
};

/**
 * Converts a models.dev payload into `key -> metadata` for one provider,
 * where `key` is `${providerId}/${modelId}`. Only providers present in the
 * payload are walked; callers decide which keys they care about, so a model
 * absent upstream simply produces no entry rather than a defaulted one.
 */
export const convertModelsDevPayload = (
	payload: unknown
): ReadonlyMap<string, ModelMetadataEntry> => {
	const converted = new Map<string, ModelMetadataEntry>();
	for (const [providerId, models] of modelsDevBlocksFromPayload(payload)) {
		for (const [modelId, model] of models) {
			converted.set(`${providerId}/${modelId}`, metadataForModel(model));
		}
	}
	return converted;
};
