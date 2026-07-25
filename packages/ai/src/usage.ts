import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type { CodingAgentUIMessage } from "./message";
import type { CodingMessageUsage } from "./metadata";
import type { ModelCost } from "./models";

const TRAILING_ZERO = /\.0$/;

/** Map AI SDK v6 `LanguageModelUsage` into our persisted usage shape. */
export const toCodingMessageUsage = (
	usage: LanguageModelUsage | undefined
): CodingMessageUsage | null => {
	if (!usage) {
		return null;
	}
	const inputTokens = usage.inputTokens;
	const outputTokens = usage.outputTokens;
	if (inputTokens === undefined || outputTokens === undefined) {
		return null;
	}
	const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
	const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
	const reasoningTokens = usage.outputTokenDetails?.reasoningTokens;
	const totalTokens = usage.totalTokens;
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
export const getContextTokens = (usage: CodingMessageUsage): number =>
	usage.inputTokens + usage.outputTokens;

/** USD cost for a single message usage. `null` when pricing is unknown. */
export const calculateUsageCostUsd = (
	cost: ModelCost | null | undefined,
	usage: CodingMessageUsage
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

/** `"34.3K"` / `"1.2M"` / `"999"`. */
export const formatTokenCount = (n: number): string => {
	if (n < 1000) {
		return String(Math.round(n));
	}
	if (n < 1_000_000) {
		const k = n / 1000;
		const formatted = k >= 100 ? k.toFixed(0) : k.toFixed(1);
		return `${formatted.replace(TRAILING_ZERO, "")}K`;
	}
	const m = n / 1_000_000;
	const formatted = m >= 100 ? m.toFixed(0) : m.toFixed(1);
	return `${formatted.replace(TRAILING_ZERO, "")}M`;
};

/** `"$0.02"` / `"<$0.01"` / `"$0.00"`. */
export const formatUsdAmount = (n: number): string => {
	if (n === 0) {
		return "$0.00";
	}
	if (n < 0.01) {
		return "<$0.01";
	}
	return `$${n.toFixed(2)}`;
};

/**
 * `messageMetadata` callback for `createAgentUIStreamResponse` / `createAgentUIStream`.
 * Attaches persisted usage on the final stream part.
 */
export const buildUsageMessageMetadata = (options: {
	part: TextStreamPart<ToolSet>;
}): CodingAgentUIMessage["metadata"] | undefined => {
	if (options.part.type !== "finish") {
		return;
	}
	const usage = toCodingMessageUsage(options.part.totalUsage);
	if (!usage) {
		return;
	}
	return { usage };
};
