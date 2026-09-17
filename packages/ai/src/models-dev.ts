import { isArray, isString, isUndefined } from "@wincode/runtime-utils";
// The single models.dev -> Wincode metadata converter. Both the offline
// generator (`scripts/sync-model-metadata.ts`) and the runtime pricing refresh
// call this, so a fact can only ever be interpreted one way. See ADR-0014.
//
// This module MUST NOT import `./generated/*`. The generator imports it, so a
// generated import here would close a cycle and break regeneration from a clean
// tree. The read path over the generated snapshot lives in
// `./model-metadata-snapshot`.

import {
	isFiniteNonNegativeNumber,
	isNonNegativeInteger,
	isPlainObject,
	isPositiveInteger,
	omitUndefined,
} from "@wincode/runtime-utils";
import { pickBy } from "es-toolkit/object";
import type { UnknownRecord } from "type-fest";
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
): readonly UnknownRecord[] | undefined =>
	isArray(value)
		? value.filter((option): option is UnknownRecord => isPlainObject(option))
		: undefined;

const nonNegativeNumber = (value: unknown): number | undefined =>
	isFiniteNonNegativeNumber(value) ? value : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
	isNonNegativeInteger(value) ? value : undefined;

const positiveInteger = (value: unknown): number | undefined =>
	isPositiveInteger(value) ? value : undefined;

const LEVEL_IDS: ReadonlySet<string> = new Set(modelVariantIds);

const asLevels = (value: unknown): readonly ModelVariant[] | undefined => {
	if (!isArray(value)) {
		return;
	}
	// The catalog speaks a closed set of level identifiers. Upstream effort
	// values outside it are dropped rather than emitted as an unusable level.
	const levels = value.filter(
		(level): level is ModelVariant => isString(level) && LEVEL_IDS.has(level)
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
	const budgetBounded = !(isUndefined(budgetMin) && isUndefined(budgetMax));
	// A published budget range is a reasoning control even with no ladder: it
	// says how much thinking the model may do. With no switch and no ladder the
	// user has nothing to pick, so the model gets no selectable level and its
	// budget is derived rather than chosen. Without recording this, Claude 4.5
	// would look like a model with no reasoning control at all.
	const switchable = !isUndefined(toggle) || budgetBounded;
	if (!(switchable || levels)) {
		return;
	}
	return {
		...pickBy({ toggle: toggle ? true : undefined, levels }, Boolean),
		...omitUndefined({ budgetMin, budgetMax }),
		...(budgetBounded && !toggle && !levels
			? { unlevelled: true as const }
			: {}),
	};
};

const toCost = (raw: unknown): ModelCost | undefined => {
	if (!isPlainObject(raw)) {
		return;
	}
	const input = nonNegativeNumber(raw.input);
	const output = nonNegativeNumber(raw.output);
	if (isUndefined(input) || isUndefined(output)) {
		return;
	}
	const cacheRead = nonNegativeNumber(raw.cache_read);
	const cacheWrite = nonNegativeNumber(raw.cache_write);
	return {
		input,
		output,
		...omitUndefined({ cacheRead, cacheWrite }),
	};
};

const CONTEXT_OVER_200K_THRESHOLD = 200_000;

/**
 * `context_over_200k` is a tier at a fixed threshold, not a second concept.
 * Folding it in here keeps the cost model single-shaped.
 */
const toTiers = (raw: unknown): readonly ModelCostTier[] => {
	if (!isPlainObject(raw)) {
		return [];
	}
	const tiers = isArray(raw.tiers) ? raw.tiers : [];
	const parsed: ModelCostTier[] = [];
	for (const tier of tiers) {
		if (!isPlainObject(tier)) {
			continue;
		}
		const threshold = isPlainObject(tier.tier) ? tier.tier : undefined;
		const size = positiveInteger(threshold?.size);
		const rates = toCost(tier);
		if (isUndefined(size) || !rates) {
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
	if (!isPlainObject(raw)) {
		return;
	}
	const context = positiveInteger(raw.context);
	if (isUndefined(context)) {
		return;
	}
	const output = positiveInteger(raw.output);
	return { context, ...omitUndefined({ output }) };
};

export const metadataForModel = (raw: ModelsDevModel): ModelMetadataEntry => {
	const thinking = toThinkingPolicy(raw.reasoning_options);
	const cost = toCost(raw.cost);
	const limits = toLimits(raw.limit);
	const tiers = toTiers(raw.cost);
	return {
		...pickBy({ cost, limits, thinking }, Boolean),
		...pickBy({ tiers }, (value) => value.length > 0),
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
