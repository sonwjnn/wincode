import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type { CodingAgentUIMessage } from "./message";
import type { CodingMessageUsage } from "./metadata";
import {
	calculateModelUsageCostUsd,
	formatModelTokenCount,
	formatModelUsdAmount,
	getModelContextTokens,
	normalizeModelUsage,
} from "./model-usage";
import type { ModelCost } from "./models";

/** Compatibility adapter from AI SDK usage to the focused model contract. */
export const toCodingMessageUsage = (
	usage: LanguageModelUsage | undefined
): CodingMessageUsage | null => normalizeModelUsage(usage);

/** Compatibility alias for the focused model context calculation. */
export const getContextTokens = (usage: CodingMessageUsage): number =>
	getModelContextTokens(usage);

/** Compatibility alias for focused model usage cost accounting. */
export const calculateUsageCostUsd = (
	cost: ModelCost | null | undefined,
	usage: CodingMessageUsage
): number | null => calculateModelUsageCostUsd(cost, usage);

/** Compatibility alias for focused model token formatting. */
export const formatTokenCount = (n: number): string => formatModelTokenCount(n);

/** Compatibility alias for focused model currency formatting. */
export const formatUsdAmount = (n: number): string => formatModelUsdAmount(n);

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
