import { isArray, isString, isUndefined } from "@wincode/utils";
// The single models.dev -> Wincode metadata converter. Both the build-time
// catalog generator and runtime pricing refresh call this, so a fact can only
// ever be interpreted one way. See ADR-0049.
//
// This module MUST NOT import `./generated/*`. The generator imports it, so a
// generated import here would close a cycle and break regeneration from a clean
// tree. SDK Providers consume the complete generated ProviderModel arrays.

import {
	isFiniteNonNegativeNumber,
	isNonNegativeInteger,
	isPlainObject,
	isPositiveInteger,
	omitUndefined,
	pickBy,
	pickTruthy,
} from "@wincode/utils";
import type { UnknownRecord } from "type-fest";
import { deepSeekEffortAliasFor } from "./model-families/deepseek.ts";
import type {
	ModelCost,
	ModelCostTier,
	ModelLimits,
	ModelMetadataEntry,
	ModelThinkingPolicy,
	ThinkingLevel,
} from "./model-metadata.ts";
import {
	type ModelsDevModel,
	modelsDevBlocksFromPayload,
} from "./models-dev-payload.ts";
import { thinkingLevelIds } from "./thinking-level.ts";

export type {
	ModelCost,
	ModelCostTier,
	ModelLimits,
	ModelMetadataEntry,
	ModelThinkingPolicy,
	ThinkingLevel,
} from "./model-metadata.ts";
export { modelMetadataEntrySchema } from "./model-metadata.ts";
export type { ModelsDevModel } from "./models-dev-payload.ts";

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

const THINKING_LEVEL_IDS: ReadonlySet<string> = new Set(
	thinkingLevelIds.filter((level) => level !== "off")
);

type ModelSource = Readonly<{ modelId: string; providerId: string }>;

const asLevels = (
	value: unknown,
	source: ModelSource | undefined
): readonly ThinkingLevel[] | undefined => {
	if (!isArray(value)) {
		return;
	}
	const levels = new Set<ThinkingLevel>();
	for (const rawLevel of value) {
		if (!isString(rawLevel)) {
			continue;
		}
		const canonical =
			deepSeekEffortAliasFor(source?.providerId, source?.modelId, rawLevel) ??
			rawLevel;
		if (THINKING_LEVEL_IDS.has(canonical)) {
			levels.add(canonical as ThinkingLevel);
		}
	}
	return levels.size === 0 ? undefined : [...levels];
};

const toThinkingPolicy = (
	raw: unknown,
	source: ModelSource | undefined
): ModelThinkingPolicy | undefined => {
	const options = parseReasoningOptions(raw);
	if (!options) {
		return;
	}
	const effort = options.find((option) => option.type === "effort");
	const budget = options.find((option) => option.type === "budget_tokens");
	const toggle = options.find((option) => option.type === "toggle");
	const levels = asLevels(effort?.values, source);
	const effortValues = effort?.values;
	const hasToggle =
		!isUndefined(toggle) ||
		(isArray(effortValues) &&
			(effortValues.includes("none") ||
				effortValues.includes("off") ||
				effortValues.includes("thinking")));
	const budgetMin = nonNegativeInteger(budget?.min);
	const budgetMax = nonNegativeInteger(budget?.max);
	const budgetBounded = !(isUndefined(budgetMin) && isUndefined(budgetMax));
	// A source-published `none` value is not a selectable ThinkingLevel
	// level. Preserve it as a toggle when the source has no separate toggle.
	// A published budget range is a reasoning control even with no ladder.
	// Preserve it as unlevelled so request adapters can derive a budget, while
	// the shared reasoning defaults remain available to model selection.
	const switchable = hasToggle || budgetBounded;
	if (!(switchable || levels)) {
		return;
	}
	return {
		...pickTruthy({ toggle: hasToggle ? true : undefined, levels }),
		...omitUndefined({ budgetMin, budgetMax }),
		...(budgetBounded && !hasToggle && !levels
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

export const metadataForModel = (
	raw: ModelsDevModel,
	source?: ModelSource
): ModelMetadataEntry => {
	const thinking = toThinkingPolicy(raw.reasoning_options, source);
	const cost = toCost(raw.cost);
	const limits = toLimits(raw.limit);
	const tiers = toTiers(raw.cost);
	return {
		...pickTruthy({ cost, limits, thinking }),
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
			converted.set(
				`${providerId}/${modelId}`,
				metadataForModel(model, { modelId, providerId })
			);
		}
	}
	return converted;
};
