import type { ProviderModel } from "@wincode/ai";
import { calculateModelUsageCostUsd } from "@wincode/ai";
import { isNull } from "@wincode/utils";
import {
	type ModelPricingEntry,
	pricingEntryForProviderModel,
} from "@/modules/model-pricing";
import type { CacheWarmingStatus } from "@/modules/prompt-cache/cache-warming";
import {
	isSameProviderModelIdentity,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import type {
	SessionMessage,
	SessionMessageUsage,
} from "@/modules/sessions/message";
import type { SessionUsageEntry } from "@/modules/sessions/storage/session-store";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import {
	estimateSessionContextTokens,
	type SessionContextUsage,
} from "./context-usage";
import { resolveContextWindowTokens } from "./context-window";

export type SessionUsageSummary = {
	/** Estimated USD for measured usage with complete rates, or `null` when every rate is unknown. */
	costUsd: number | null;
	/** Whether the total covers every measured usage entry or omits unknown rates. */
	costCoverage: "complete" | "partial" | "unknown";
	/** How many real Agent Turns contributed a cost estimate. */
	costedTurns: number;
	/** How many compaction summaries contributed a cost estimate. */
	costedCompactions: number;
	/** How many separate usage entries contributed a cost estimate. */
	costedUsageEntries: number;
	/** Current Session Host cache warmer state; never affects context usage. */
	cacheWarmingStatus: CacheWarmingStatus;
	/** Session-total input tokens, including cache reads and writes. */
	inputTokens: number;
	/** Session-total generated output tokens. */
	outputTokens: number;
	/** Session-total cache reads, kept separate from context usage. */
	cacheReadTokens: number;
	/** Session-total cache writes, kept separate from context usage. */
	cacheWriteTokens: number;
	/** Latest assistant turn's cache-read share of its total input, or `null` when unknown. */
	cacheHitPercent: number | null;
	/** Effective context limit: explicit override, selected-model metadata, then fallback. */
	contextLimit: number;
	/** Rounded active-context occupancy; may exceed 100 when over the model limit. */
	contextPercent: number;
	contextTokens: number;
	contextSource: SessionContextUsage["source"];
};

type MessageUsageState = {
	lastSelection: ProviderModelSelection | null;
	lastUsage: SessionMessageUsage | null;
};

const collectMessageUsage = (
	messages: readonly SessionMessage[]
): MessageUsageState => {
	let lastUsage: SessionMessageUsage | null = null;
	let lastSelection: ProviderModelSelection | null = null;
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

const providerModelForSelection = (
	models: readonly ProviderModel[] | undefined,
	selection: ProviderModelSelection
): ProviderModel | undefined =>
	models?.find((model) => isSameProviderModelIdentity(model, selection));

const resolveProviderModelPricing = (
	selection: ProviderModelSelection,
	providerModels: readonly ProviderModel[] | undefined
): ModelPricingEntry | undefined => {
	const providerModel = providerModelForSelection(providerModels, selection);
	return providerModel === undefined
		? undefined
		: pricingEntryForProviderModel(providerModel);
};

type SessionUsageTotals = {
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	costedCompactions: number;
	costedTurns: number;
	costedUsageEntries: number;
	inputTokens: number;
	measuredUsageCount: number;
	outputTokens: number;
};

const createSessionUsageTotals = (): SessionUsageTotals => ({
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	costedCompactions: 0,
	costedTurns: 0,
	costedUsageEntries: 0,
	inputTokens: 0,
	measuredUsageCount: 0,
	outputTokens: 0,
});

const addUsageTokens = (
	totals: SessionUsageTotals,
	usage: SessionMessageUsage
): void => {
	totals.measuredUsageCount += 1;
	totals.inputTokens += usage.inputTokens;
	totals.outputTokens += usage.outputTokens;
	totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
	totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
};

const addUsageCost = (
	totals: SessionUsageTotals,
	pricing: ModelPricingEntry | undefined,
	usage: SessionMessageUsage
): boolean => {
	const cost = turnCostUsd(pricing, usage);
	if (isNull(cost)) {
		return false;
	}
	totals.cost += cost;
	return true;
};

const costCoverageFor = (
	totals: SessionUsageTotals
): SessionUsageSummary["costCoverage"] => {
	const costedUsageCount =
		totals.costedTurns + totals.costedUsageEntries + totals.costedCompactions;
	if (costedUsageCount === 0) {
		return "unknown";
	}
	return costedUsageCount < totals.measuredUsageCount ? "partial" : "complete";
};

const collectSessionUsage = (
	messages: readonly SessionMessage[],
	usageEntries: readonly SessionUsageEntry[],
	compactions: readonly SessionCompaction[],
	fallbackModel: ProviderModelSelection,
	providerModels: readonly ProviderModel[] | undefined
): Pick<
	SessionUsageSummary,
	| "inputTokens"
	| "outputTokens"
	| "cacheReadTokens"
	| "cacheWriteTokens"
	| "costUsd"
	| "costCoverage"
	| "costedTurns"
	| "costedCompactions"
	| "costedUsageEntries"
> => {
	const totals = createSessionUsageTotals();
	for (const message of messages) {
		const usage = message.metadata?.usage;
		if (message.role !== "assistant" || !usage) {
			continue;
		}
		addUsageTokens(totals, usage);
		const selection = message.metadata?.model ?? fallbackModel;
		const pricing = resolveProviderModelPricing(selection, providerModels);
		if (addUsageCost(totals, pricing, usage)) {
			totals.costedTurns += 1;
		}
	}
	for (const entry of usageEntries) {
		addUsageTokens(totals, entry.usage);
		const pricing = resolveProviderModelPricing(entry.model, providerModels);
		if (addUsageCost(totals, pricing, entry.usage)) {
			totals.costedUsageEntries += 1;
		}
	}
	for (const compaction of compactions) {
		const usage = compaction.summarizationUsage;
		if (!usage) {
			continue;
		}
		addUsageTokens(totals, usage);
		const pricing = resolveProviderModelPricing(
			compaction.summarizationModel,
			providerModels
		);
		if (addUsageCost(totals, pricing, usage)) {
			totals.costedCompactions += 1;
		}
	}
	const costedUsageCount =
		totals.costedTurns + totals.costedUsageEntries + totals.costedCompactions;
	return {
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheReadTokens: totals.cacheReadTokens,
		cacheWriteTokens: totals.cacheWriteTokens,
		costUsd: costedUsageCount === 0 ? null : totals.cost,
		costCoverage: costCoverageFor(totals),
		costedTurns: totals.costedTurns,
		costedCompactions: totals.costedCompactions,
		costedUsageEntries: totals.costedUsageEntries,
	};
};

/** Active-context occupancy is separate from full-transcript usage and billing totals. */
export const summarizeSessionUsage = (
	messages: readonly SessionMessage[],
	fallbackModel: ProviderModelSelection,
	usageEntries: readonly SessionUsageEntry[] = [],
	cacheWarmingStatus: CacheWarmingStatus = "idle",
	providerModels?: readonly ProviderModel[],
	compactions: readonly SessionCompaction[] = [],
	contextMessages: readonly SessionMessage[] = messages,
	contextSnapshot?: ConfigSnapshot
): SessionUsageSummary | null => {
	const { lastUsage } = collectMessageUsage(messages);
	if (isNull(lastUsage)) {
		return null;
	}
	const selectedProviderModel = providerModelForSelection(
		providerModels,
		fallbackModel
	);
	const contextLimit = resolveContextWindowTokens(
		contextSnapshot,
		selectedProviderModel?.limits?.contextWindowTokens
	).tokens;
	const context = estimateSessionContextTokens(
		contextMessages,
		undefined,
		fallbackModel
	);
	const contextTokens = context.tokens;
	const contextPercent = Math.round((contextTokens / contextLimit) * 100);
	return {
		...collectSessionUsage(
			messages,
			usageEntries,
			compactions,
			fallbackModel,
			providerModels
		),
		cacheHitPercent:
			lastUsage.inputTokens > 0
				? ((lastUsage.cacheReadTokens ?? 0) / lastUsage.inputTokens) * 100
				: null,
		cacheWarmingStatus,
		contextLimit,
		contextPercent,
		contextTokens,
		contextSource: context.source,
	};
};
