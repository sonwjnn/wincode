import { z } from "zod";
import type { ModelCost } from "./models";

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

/** USD cost for a single model usage. `null` when pricing is unknown. */
export const calculateModelUsageCostUsd = (
	cost: ModelCost | null | undefined,
	usage: ModelUsage
): number | null => {
	if (!cost) {
		return null;
	}
	const cacheRead = usage.cacheReadTokens ?? 0;
	const uncachedInput = Math.max(0, usage.inputTokens - cacheRead);
	const cacheReadRate = cost.cacheRead ?? cost.input;
	const inputCost = (uncachedInput / 1_000_000) * cost.input;
	const cacheReadCost = (cacheRead / 1_000_000) * cacheReadRate;
	const outputCost = (usage.outputTokens / 1_000_000) * cost.output;
	return inputCost + cacheReadCost + outputCost;
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
