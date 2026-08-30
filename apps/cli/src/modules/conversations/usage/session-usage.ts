import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type CodingMessageUsage,
	calculateUsageCostUsd,
	getContextTokens,
} from "@wincode/ai";
import {
	type ModelPricingEntry,
	type ModelPricingTable,
	resolveModelPricing,
} from "@/modules/model-pricing";
import type { ConversationCompaction } from "../compaction";
export type SessionUsageSummary = {
	/** `null` when no pricing table has an entry for the current model. */
	contextLimit: number | null;
	/** `null` when `contextLimit` is unknown. */
	contextPercent: number | null;
	contextTokens: number;
	costUsd: number | null;
};

const clampPercent = (percent: number): number =>
	Math.max(0, Math.min(100, Math.round(percent)));

const costForMessage = (
	message: CodingAgentUIMessage,
	resolve: (selection: ChatModelSelection) => ModelPricingEntry | null
): number | null => {
	const usage = message.metadata?.usage;
	if (!usage) {
		return null;
	}
	const modelSelection = message.metadata?.model;
	const pricing = modelSelection ? resolve(modelSelection) : null;
	return calculateUsageCostUsd(pricing?.cost, usage);
};

const costForCompaction = (
	compaction: ConversationCompaction,
	resolve: (selection: ChatModelSelection) => ModelPricingEntry | null
): number | null => {
	if (!compaction.summarizationUsage) {
		return null;
	}
	const pricing = resolve(compaction.summarizationModel);
	return calculateUsageCostUsd(pricing?.cost, compaction.summarizationUsage);
};

type MessageUsageState = {
	costKnown: boolean;
	lastPricing: ModelPricingEntry | null;
	lastSelection: ChatModelSelection | null;
	lastUsage: CodingMessageUsage | null;
	lastUsageIndex: number;
	totalCost: number;
};

const collectMessageUsage = (
	messages: readonly CodingAgentUIMessage[],
	resolve: (selection: ChatModelSelection) => ModelPricingEntry | null
): MessageUsageState => {
	let totalCost = 0;
	let costKnown = false;
	let lastUsage: CodingMessageUsage | null = null;
	let lastPricing: ModelPricingEntry | null = null;
	let lastSelection: ChatModelSelection | null = null;
	let lastUsageIndex = -1;

	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant" || !message.metadata?.usage) {
			continue;
		}
		lastUsage = message.metadata.usage;
		lastUsageIndex = index;
		lastSelection = message.metadata.model ?? null;
		lastPricing = lastSelection ? resolve(lastSelection) : null;
		const messageCost = costForMessage(message, resolve);
		if (messageCost !== null) {
			totalCost += messageCost;
			costKnown = true;
		}
	}

	return {
		costKnown,
		lastPricing,
		lastSelection,
		lastUsage,
		lastUsageIndex,
		totalCost,
	};
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

/**
 * Aggregate the current context usage and cumulative cost for a session.
 * Returns `null` when no assistant turn has produced usage yet, so the footer
 * stays hidden on fresh sessions.
 */
export const summarizeSessionUsage = (
	messages: readonly CodingAgentUIMessage[],
	fallbackModel: ChatModelSelection,
	table: ModelPricingTable,
	compactions: readonly ConversationCompaction[] = []
): SessionUsageSummary | null => {
	const resolve = (selection: ChatModelSelection) =>
		resolveModelPricing(table, selection);
	const messageUsage = collectMessageUsage(messages, resolve);
	const latestCompaction = findLatestCompaction(compactions);

	let totalCost = messageUsage.totalCost;
	let costKnown = messageUsage.costKnown;
	for (const compaction of compactions) {
		const compactionCost = costForCompaction(compaction, resolve);
		if (compactionCost !== null) {
			totalCost += compactionCost;
			costKnown = true;
		}
	}

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
	const primaryPricing = useCompactionContext
		? resolve(selection)
		: messageUsage.lastPricing;
	const pricing =
		primaryPricing ?? resolve(selection) ?? resolve(fallbackModel);
	const contextLimit = pricing?.contextLimit ?? null;
	let contextTokens = 0;
	if (useCompactionContext && latestCompaction !== null) {
		contextTokens = latestCompaction.tokensAfter;
	} else if (messageUsage.lastUsage !== null) {
		contextTokens = getContextTokens(messageUsage.lastUsage);
	}
	const contextPercent =
		contextLimit !== null && contextLimit > 0
			? clampPercent((contextTokens / contextLimit) * 100)
			: null;
	// Independent of whether the *last* turn happens to have known pricing —
	// a session that ends on an unpriced (e.g. OAuth-only) model must not
	// lose the cost it already accumulated from earlier, priced turns.
	const costUsd = costKnown ? totalCost : null;

	return {
		contextLimit,
		contextPercent,
		contextTokens,
		costUsd,
	};
};
