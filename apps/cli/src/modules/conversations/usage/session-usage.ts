import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type CodingMessageUsage,
	getContextTokens,
} from "@wincode/ai";
import type { ModelPricingTable } from "@/modules/model-pricing";
import { resolveModelPricing } from "@/modules/model-pricing";
import type { ConversationCompaction } from "../compaction";

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
	lastUsage: CodingMessageUsage | null;
	lastUsageIndex: number;
};

const collectMessageUsage = (
	messages: readonly CodingAgentUIMessage[]
): MessageUsageState => {
	let lastUsage: CodingMessageUsage | null = null;
	let lastSelection: ChatModelSelection | null = null;
	let lastUsageIndex = -1;
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant" || !message.metadata?.usage) {
			continue;
		}
		lastUsage = message.metadata.usage;
		lastUsageIndex = index;
		lastSelection = message.metadata.model ?? null;
	}
	return { lastSelection, lastUsage, lastUsageIndex };
};

const findLatestCompaction = (
	compactions: readonly ConversationCompaction[]
): ConversationCompaction | null => {
	let latest: ConversationCompaction | null = null;
	for (const compaction of compactions) {
		if (latest === null || compaction.sequence > latest.sequence) {
			latest = compaction;
		}
	}
	return latest;
};

/** Aggregate context occupancy for the current local conversation. */
export const summarizeSessionUsage = (
	messages: readonly CodingAgentUIMessage[],
	fallbackModel: ChatModelSelection,
	table: ModelPricingTable,
	compactions: readonly ConversationCompaction[] = []
): SessionUsageSummary | null => {
	const messageUsage = collectMessageUsage(messages);
	const latestCompaction = findLatestCompaction(compactions);
	const compactionThroughIndex =
		latestCompaction === null
			? -1
			: messages.findIndex(
					(message) => message.id === latestCompaction.throughMessageUiId
				);
	const useCompactionContext =
		latestCompaction !== null &&
		(messageUsage.lastUsage === null ||
			messageUsage.lastUsageIndex <= compactionThroughIndex);
	if (messageUsage.lastUsage === null && !useCompactionContext) {
		return null;
	}
	let selection = messageUsage.lastSelection ?? fallbackModel;
	if (useCompactionContext) {
		selection = latestCompaction?.summarizationModel ?? fallbackModel;
	}
	const contextLimit =
		resolveModelPricing(table, selection)?.contextLimit ?? null;
	let contextTokens = 0;
	if (useCompactionContext && latestCompaction !== null) {
		contextTokens = latestCompaction.tokensAfter;
	} else if (messageUsage.lastUsage) {
		contextTokens = getContextTokens(messageUsage.lastUsage);
	}
	const contextPercent =
		contextLimit !== null && contextLimit > 0
			? clampPercent((contextTokens / contextLimit) * 100)
			: null;
	return { contextLimit, contextPercent, contextTokens };
};
