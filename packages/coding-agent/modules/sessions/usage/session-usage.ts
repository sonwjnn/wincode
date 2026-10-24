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
	/** How many separate usage entries contributed a cost estimate. */
	costedUsageEntries: number;
	/** Current Session Host cache warmer state; never affects context usage. */
	cacheWarmingStatus: CacheWarmingStatus;
	/** Session-total cache reads, kept separate from context usage. */
	cacheReadTokens: number;
	/** Session-total cache writes, kept separate from context usage. */
	cacheWriteTokens: number;
	/** Selected model's effective context limit: override, metadata, then fallback. */
	contextLimit: number;
	/** Context occupancy percentage, clamped to the visible 0–100 range. */
	contextPercent: number;
	contextTokens: number;
	contextSource: SessionContextUsage["source"];
};

const clampPercent = (percent: number): number =>
	Math.max(0, Math.min(100, Math.round(percent)));

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

const collectSessionUsage = (
	messages: readonly SessionMessage[],
	usageEntries: readonly SessionUsageEntry[],
	fallbackModel: ProviderModelSelection,
	providerModels: readonly ProviderModel[] | undefined
): Pick<
	SessionUsageSummary,
	| "cacheReadTokens"
	| "cacheWriteTokens"
	| "costUsd"
	| "costCoverage"
	| "costedTurns"
	| "costedUsageEntries"
> => {
	let total = 0;
	let measuredTurns = 0;
	let costedTurns = 0;
	let costedUsageEntries = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	for (const message of messages) {
		const usage = message.metadata?.usage;
		if (message.role !== "assistant" || !usage) {
			continue;
		}
		measuredTurns += 1;
		cacheReadTokens += usage.cacheReadTokens ?? 0;
		cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		const selection = message.metadata?.model ?? fallbackModel;
		const entry = resolveProviderModelPricing(selection, providerModels);
		const cost = turnCostUsd(entry ?? undefined, usage);
		if (!isNull(cost)) {
			total += cost;
			costedTurns += 1;
		}
	}
	for (const entry of usageEntries) {
		cacheReadTokens += entry.usage.cacheReadTokens ?? 0;
		cacheWriteTokens += entry.usage.cacheWriteTokens ?? 0;
		const pricing = resolveProviderModelPricing(entry.model, providerModels);
		const cost = turnCostUsd(pricing ?? undefined, entry.usage);
		if (!isNull(cost)) {
			total += cost;
			costedUsageEntries += 1;
		}
	}
	const costedUsageCount = costedTurns + costedUsageEntries;
	const measuredUsageCount = measuredTurns + usageEntries.length;
	let costCoverage: SessionUsageSummary["costCoverage"];
	if (costedUsageCount === 0) {
		costCoverage = "unknown";
	} else if (costedUsageCount < measuredUsageCount) {
		costCoverage = "partial";
	} else {
		costCoverage = "complete";
	}
	return {
		cacheReadTokens,
		cacheWriteTokens,
		costUsd: costedUsageCount === 0 ? null : total,
		costCoverage,
		costedTurns,
		costedUsageEntries,
	};
};

/** Context comes from the active projection; billing always retains the full transcript. */
export const summarizeSessionUsage = (
	messages: readonly SessionMessage[],
	fallbackModel: ProviderModelSelection,
	usageEntries: readonly SessionUsageEntry[] = [],
	cacheWarmingStatus: CacheWarmingStatus = "idle",
	providerModels?: readonly ProviderModel[],
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
	const contextPercent = clampPercent((contextTokens / contextLimit) * 100);
	return {
		...collectSessionUsage(
			messages,
			usageEntries,
			fallbackModel,
			providerModels
		),
		cacheWarmingStatus,
		contextLimit,
		contextPercent,
		contextTokens,
		contextSource: context.source,
	};
};
