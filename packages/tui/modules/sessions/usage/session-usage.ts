import {
	calculateModelUsageCostUsd,
	getModelContextTokens,
} from "@wincode/ai/model-usage";
import type { ChatModelSelection } from "@wincode/ai/models";
import type {
	ModelPricingEntry,
	ModelPricingTable,
} from "@/modules/model-pricing";
import { resolveModelMetadata } from "@/modules/model-pricing";
import type {
	SessionMessage,
	SessionMessageUsage,
} from "@/modules/sessions/message";

export type SessionUsageSummary = {
	/** Estimated USD for every measured turn in the session, or `null` when no turn has a usable rate. */
	costUsd: number | null;
	/** How many turns contributed a cost estimate. */
	costedTurns: number;
	/** `null` when the catalog has no limit for the current model. */
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
 * Cost for one measured turn. The shared AI helper owns cache and tier
 * semantics so every cost surface prices usage identically.
 */
export const turnCostUsd = (
	entry: ModelPricingEntry | undefined,
	usage: SessionMessageUsage
): number | null => calculateModelUsageCostUsd(entry, usage);

const collectCost = (
	messages: readonly SessionMessage[],
	fallbackModel: ChatModelSelection,
	table: ModelPricingTable
): { costUsd: number | null; costedTurns: number } => {
	let total = 0;
	let costedTurns = 0;
	for (const message of messages) {
		const usage = message.metadata?.usage;
		if (message.role !== "assistant" || !usage) {
			continue;
		}
		const selection = message.metadata?.model ?? fallbackModel;
		const entry = resolveModelMetadata(table, selection);
		const cost = turnCostUsd(entry ?? undefined, usage);
		if (cost !== null) {
			total += cost;
			costedTurns += 1;
		}
	}
	return { costUsd: costedTurns === 0 ? null : total, costedTurns };
};

/**
 * Displays only the last completed provider usage for the context measure.
 * Compaction estimates are diagnostic metadata and never replace the usage
 * bar's provider measurement. Cost accumulates across the session instead,
 * because a per-turn figure answers a question nobody asked while a session
 * total answers the one everybody does.
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
		resolveModelMetadata(table, selection)?.limits?.context ?? null;
	const contextTokens = getModelContextTokens(lastUsage);
	const contextPercent =
		contextLimit !== null && contextLimit > 0
			? clampPercent((contextTokens / contextLimit) * 100)
			: null;
	return {
		...collectCost(messages, fallbackModel, table),
		contextLimit,
		contextPercent,
		contextTokens,
	};
};
