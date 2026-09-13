import { z } from "zod";
import type { ModelCost, ModelCostTier, ModelMetadataEntry } from "./models";
export const modelUsageSchema = z
	.object({
		cacheReadTokens: z.number().int().nonnegative().optional(),
		cacheWriteTokens: z.number().int().nonnegative().optional(),
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		reasoningTokens: z.number().int().nonnegative().optional(),
		totalTokens: z.number().int().nonnegative().optional(),
	})
	.strict();

const TOKENS_PER_MILLION = 1_000_000;

type UsagePricing = ModelCost | ModelMetadataEntry;
type ResolvedUsagePricing = {
	readonly cost: ModelCost | undefined;
	readonly tiers: readonly ModelCostTier[] | undefined;
};

const isModelCost = (value: unknown): value is ModelCost => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	return (
		"input" in value &&
		typeof value.input === "number" &&
		"output" in value &&
		typeof value.output === "number"
	);
};

const resolveUsagePricing = (pricing: UsagePricing): ResolvedUsagePricing => {
	if ("cost" in pricing) {
		return {
			cost: isModelCost(pricing.cost) ? pricing.cost : undefined,
			tiers: pricing.tiers,
		};
	}
	return {
		cost: isModelCost(pricing) ? pricing : undefined,
		tiers: undefined,
	};
};

export type ModelUsage = z.infer<typeof modelUsageSchema>;

const nonNegativeInteger = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: undefined;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;

const nestedToken = (
	value: Record<string, unknown> | undefined,
	key: string
): number | undefined => nonNegativeInteger(value?.[key]);

/** Normalize provider or SDK usage without exposing its provider-specific type. */
export const normalizeModelUsage = (value: unknown): ModelUsage | null => {
	const usage = objectValue(value);
	const inputTokens = nonNegativeInteger(usage?.inputTokens);
	const outputTokens = nonNegativeInteger(usage?.outputTokens);
	if (inputTokens === undefined || outputTokens === undefined) {
		return null;
	}
	const inputDetails = objectValue(usage?.inputTokenDetails);
	const outputDetails = objectValue(usage?.outputTokenDetails);
	const cacheReadTokens =
		nestedToken(inputDetails, "cacheReadTokens") ??
		nonNegativeInteger(usage?.cachedInputTokens);
	const cacheWriteTokens = nestedToken(inputDetails, "cacheWriteTokens");
	const reasoningTokens =
		nestedToken(outputDetails, "reasoningTokens") ??
		nonNegativeInteger(usage?.reasoningTokens);
	const totalTokens = nonNegativeInteger(usage?.totalTokens);
	return {
		inputTokens,
		outputTokens,
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
	};
};

/** Tokens charged against the context window for this turn (input + output). */
export const getModelContextTokens = (usage: ModelUsage): number =>
	usage.inputTokens + usage.outputTokens;

/**
 * USD cost for a single model usage. `null` when pricing is unknown.
 * `pricing` may be a raw cost record or catalog metadata with cost tiers.
 */
export const calculateModelUsageCostUsd = (
	pricing: UsagePricing | null | undefined,
	usage: ModelUsage
): number | null => {
	if (!pricing) {
		return null;
	}
	const { cost, tiers } = resolveUsagePricing(pricing);
	if (!cost) {
		return null;
	}
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	const uncachedInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
	const totalInput = uncachedInput + cacheRead + cacheWrite;
	const rates =
		tiers
			?.filter((candidate) => totalInput > candidate.inputTokensAbove)
			.at(-1) ?? cost;
	const inputCost = (uncachedInput / TOKENS_PER_MILLION) * rates.input;
	const outputCost = (usage.outputTokens / TOKENS_PER_MILLION) * rates.output;
	const cacheReadCost =
		(cacheRead / TOKENS_PER_MILLION) * (rates.cacheRead ?? cost.cacheRead ?? 0);
	const cacheWriteCost =
		(cacheWrite / TOKENS_PER_MILLION) *
		(rates.cacheWrite ?? cost.cacheWrite ?? 0);
	return inputCost + outputCost + cacheReadCost + cacheWriteCost;
};

const TRAILING_ZERO = /\.0$/;

/** `34.3K` / `1.2M` / `999`. */
export const formatModelTokenCount = (tokens: number): string => {
	if (tokens < 1000) {
		return String(Math.round(tokens));
	}
	if (tokens < 1_000_000) {
		const thousands = tokens / 1000;
		const formatted =
			thousands >= 100 ? thousands.toFixed(0) : thousands.toFixed(1);
		return `${formatted.replace(TRAILING_ZERO, "")}K`;
	}
	const millions = tokens / 1_000_000;
	const formatted = millions >= 100 ? millions.toFixed(0) : millions.toFixed(1);
	return `${formatted.replace(TRAILING_ZERO, "")}M`;
};

/** `"$0.02"` / `"<$0.01"` / `"$0.00"`. */
export const formatModelUsdAmount = (amount: number): string => {
	if (amount === 0) {
		return "$0.00";
	}
	if (amount < 0.01) {
		return "<$0.01";
	}
	return `$${amount.toFixed(2)}`;
};
