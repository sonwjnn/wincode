import { getModelContextTokens } from "@wincode/ai/model-usage";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { ModelPricingTable } from "@/modules/model-pricing";
import { resolveModelPricing } from "@/modules/model-pricing";
import type {
	SessionMessage,
	SessionMessageUsage,
} from "@/modules/sessions/message";

export type SessionUsageSummary = {
	/** `null` when the pricing table has no entry for the current model. */
	contextLimit: number | null;
	/** `null` when `contextLimit` is unknown. */
	contextPercent: number | null;
	contextTokens: number;
};

const clampPercent = (percent: number): number =>
	Math.max(0, Math.min(100, Math.round(percent)));

type MessageUsageState = {
	lastSelection: ChatModelSelection | null;
	lastUsage: SessionMessageUsage | null;
};

const collectMessageUsage = (
	messages: readonly SessionMessage[]
): MessageUsageState => {
	let lastUsage: SessionMessageUsage | null = null;
	let lastSelection: ChatModelSelection | null = null;
	for (const message of messages) {
		if (message.role !== "assistant" || !message.metadata?.usage) {
			continue;
		}
		lastUsage = message.metadata.usage;
		lastSelection = message.metadata.model ?? null;
	}
	return { lastSelection, lastUsage };
};

/**
 * Displays only the last completed provider usage. Compaction estimates are
 * diagnostic metadata and never replace the usage bar's provider measurement.
 */
export const summarizeSessionUsage = (
	messages: readonly SessionMessage[],
	fallbackModel: ChatModelSelection,
	table: ModelPricingTable
): SessionUsageSummary | null => {
	const { lastSelection, lastUsage } = collectMessageUsage(messages);
	if (lastUsage === null) {
		return null;
	}
	const selection = lastSelection ?? fallbackModel;
	const contextLimit =
		resolveModelPricing(table, selection)?.contextLimit ?? null;
	const contextTokens = getModelContextTokens(lastUsage);
	const contextPercent =
		contextLimit !== null && contextLimit > 0
			? clampPercent((contextTokens / contextLimit) * 100)
			: null;
	return { contextLimit, contextPercent, contextTokens };
};
