import {
	calculateModelUsageCostUsd,
	getModelContextTokens,
} from "@wincode/ai/model-usage";
import type { ChatModelSelection } from "@wincode/ai/models";
import { isNull } from "@wincode/utils";
import type {
	ModelPricingEntry,
	ModelPricingTable,
} from "@/modules/model-pricing";
import { resolveModelMetadata } from "@/modules/model-pricing";
import type { CacheWarmingStatus } from "@/modules/prompt-cache/cache-warming";
import type {
	SessionMessage,
	SessionMessageUsage,
} from "@/modules/sessions/message";
import type { SessionUsageEntry } from "@/modules/sessions/storage/session-store";

export type SessionUsageSummary = {
	/** Estimated USD for every measured turn in the session, or `null` when no turn has a usable rate. */
	costUsd: number | null;
	/** How many real Agent Turns contributed a cost estimate. */
	costedTurns: number;
	/** How many separate usage entries contributed a cost estimate. */
	costedUsageEntries: number;
	/** Current Session Host cache warmer state; never affects context usage. */
	cacheWarmingStatus: CacheWarmingStatus;
	/** Session-total cache reads, kept separate from context usage. */
	cacheReadTokens: number;
	/** Session-total cache writes, kept separate from context usage. */
	cacheWriteTokens: number;
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

const collectSessionUsage = (
	messages: readonly SessionMessage[],
	usageEntries: readonly SessionUsageEntry[],
	fallbackModel: ChatModelSelection,
	table: ModelPricingTable
): Pick<
	SessionUsageSummary,
	| "cacheReadTokens"
	| "cacheWriteTokens"
	| "costUsd"
	| "costedTurns"
	| "costedUsageEntries"
> => {
	let total = 0;
	let costedTurns = 0;
	let costedUsageEntries = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	for (const message of messages) {
		const usage = message.metadata?.usage;
		if (message.role !== "assistant" || !usage) {
			continue;
		}
		cacheReadTokens += usage.cacheReadTokens ?? 0;
		cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		const selection = message.metadata?.model ?? fallbackModel;
		const entry = resolveModelMetadata(table, selection);
		const cost = turnCostUsd(entry ?? undefined, usage);
		if (!isNull(cost)) {
			total += cost;
			costedTurns += 1;
		}
	}
	for (const entry of usageEntries) {
		cacheReadTokens += entry.usage.cacheReadTokens ?? 0;
		cacheWriteTokens += entry.usage.cacheWriteTokens ?? 0;
		const pricing = resolveModelMetadata(table, entry.model);
		const cost = turnCostUsd(pricing ?? undefined, entry.usage);
		if (!isNull(cost)) {
			total += cost;
			costedUsageEntries += 1;
		}
	}
	return {
		cacheReadTokens,
		cacheWriteTokens,
		costUsd: costedTurns + costedUsageEntries === 0 ? null : total,
		costedTurns,
		costedUsageEntries,
	};
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
	table: ModelPricingTable,
	usageEntries: readonly SessionUsageEntry[] = [],
	cacheWarmingStatus: CacheWarmingStatus = "idle"
): SessionUsageSummary | null => {
	const { lastSelection, lastUsage } = collectMessageUsage(messages);
	if (isNull(lastUsage)) {
		return null;
	}
	const selection = lastSelection ?? fallbackModel;
	const contextLimit =
		resolveModelMetadata(table, selection)?.limits?.context ?? null;
	const contextTokens = getModelContextTokens(lastUsage);
	const contextPercent =
		!isNull(contextLimit) && contextLimit > 0
			? clampPercent((contextTokens / contextLimit) * 100)
			: null;
	return {
		...collectSessionUsage(messages, usageEntries, fallbackModel, table),
		cacheWarmingStatus,
		contextLimit,
		contextPercent,
		contextTokens,
	};
};
