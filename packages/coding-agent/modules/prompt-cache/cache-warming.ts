import type { ModelStepObserver } from "@wincode/agent-core";
import type { ModelStepRequest } from "@wincode/ai/model-client";
import { createModelClient, warmModelRequest } from "@wincode/ai/model-client";
import type { ModelUsage } from "@wincode/ai/model-usage";
import { calculateModelUsageCostUsd } from "@wincode/ai/model-usage";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	promptCacheRetentionTtlMsForModel,
	supportsPromptCacheWarmingForModel,
} from "@wincode/ai/models";
import type { ChatRequest } from "@wincode/ai/sdk";
import { logger } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import type {
	ModelPricingEntry,
	ModelPricingTable,
} from "@/modules/model-pricing/model-pricing";
import { resolveModelMetadata } from "@/modules/model-pricing/model-pricing";
import type {
	CreateSessionUsageEntryInput,
	SessionStore,
	SessionUsageEntry,
} from "@/modules/sessions/storage/session-store";
import { type SessionId, toSessionUsageEntryId } from "@/shared/identifiers";

const WARMING_MARGIN_MS = 10_000;
const MAX_WARMING_HORIZON_MS = 60 * 60_000;
const MINIMUM_EXPECTED_SAVINGS_USD = 0.05;

export type CacheWarmingStatus = "idle" | "scheduled" | "warming";

/** Returns a 90%-TTL schedule only when both safety margins remain feasible. */
export const computeCacheWarmDelayMs = (ttlMs: number): number | null => {
	if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
		return null;
	}
	const delayMs = Math.floor(ttlMs * 0.9);
	return ttlMs - delayMs >= WARMING_MARGIN_MS &&
		delayMs < MAX_WARMING_HORIZON_MS
		? delayMs
		: null;
};

/**
 * Estimates whether one cache hit repays the complete warm replay. Missing
 * cache-read prices or provider cache-token measurements remain unknown.
 */
export const expectedCacheWarmSavingsUsd = (
	pricing: ModelPricingEntry | undefined,
	usage: ModelUsage
): number | null => {
	const cachedPrefixTokens =
		(usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
	if (cachedPrefixTokens <= 0 || cachedPrefixTokens > usage.inputTokens) {
		return null;
	}
	const missedHitCost = calculateModelUsageCostUsd(pricing, {
		inputTokens: usage.inputTokens,
		outputTokens: 0,
	});
	const cachedHitCost = calculateModelUsageCostUsd(pricing, {
		cacheReadTokens: cachedPrefixTokens,
		inputTokens: usage.inputTokens,
		outputTokens: 0,
	});
	const warmReplayCost = calculateModelUsageCostUsd(pricing, {
		cacheReadTokens: cachedPrefixTokens,
		inputTokens: usage.inputTokens,
		outputTokens: 1,
	});
	if (
		missedHitCost === null ||
		cachedHitCost === null ||
		warmReplayCost === null
	) {
		return null;
	}
	return missedHitCost - cachedHitCost - warmReplayCost;
};

export type SessionCacheWarming = Readonly<{
	cancel: () => void;
	dispose: () => Promise<void>;
	getStatus: () => CacheWarmingStatus;
	getUsageEntries: () => readonly SessionUsageEntry[];
	modelStepObserver: ModelStepObserver;
	subscribe: (listener: () => void) => () => void;
}>;

export type SessionCacheWarmingOptions = Readonly<{
	getPricingTable: () => ModelPricingTable;
	initialUsageEntries: readonly SessionUsageEntry[];
	sessionId: SessionId;
	store: Pick<SessionStore, "createSessionUsageEntry">;
}>;

type CacheWarmSchedule = Readonly<{
	delayMs: number;
	lastRefreshStartedAt: number;
	model: ChatModelSelection;
	request: ModelStepRequest;
	requestGeneration: number;
	requestStartedAt: number;
	ttlMs: number;
}>;

const replayRequestSnapshot = (
	request: ModelStepRequest
): ModelStepRequest | undefined => {
	const model = findSupportedChatModelSelection({
		modelId: request.target.modelId,
		providerId: request.target.providerId,
	});
	if (
		model === null ||
		request.googleCachedContent !== undefined ||
		!supportsPromptCacheWarmingForModel(model) ||
		request.target.promptCacheEnabled !== true ||
		request.target.promptCacheRetention === undefined
	) {
		return;
	}
	const { signal: _signal, ...requestWithoutSignal } = request;
	try {
		return structuredClone(requestWithoutSignal);
	} catch {
		// Requests with opaque values that cannot be faithfully snapshotted are
		// not eligible for replay.
		return;
	}
};

/** One Session-owned best-effort warmer with a separate durable cost path. */
export const createSessionCacheWarming = ({
	getPricingTable,
	initialUsageEntries,
	sessionId,
	store,
}: SessionCacheWarmingOptions): SessionCacheWarming => {
	const modelClient = createModelClient();
	const listeners = new Set<() => void>();
	const notifyListeners = (): void => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// Observers cannot affect cache warming or Session execution.
			}
		}
	};
	const usageEntries = new Map(
		initialUsageEntries.map((entry) => [entry.id, entry])
	);
	let status: CacheWarmingStatus = "idle";
	let generation = 0;
	let latestRequest: ModelStepRequest | undefined;
	let replayRequest: ModelStepRequest | undefined;
	let requestStartedAt = 0;
	let scheduleTimer: NodeJS.Timeout | undefined;
	let warmController: AbortController | undefined;
	let activeWarm: Promise<void> | undefined;

	const setStatus = (next: CacheWarmingStatus): void => {
		if (status === next) {
			return;
		}
		status = next;
		notifyListeners();
	};

	const abortWarm = (): void => {
		try {
			warmController?.abort();
		} catch {
			// Cancellation is an optimization failure only.
		}
		warmController = undefined;
	};

	const cancel = (): void => {
		generation += 1;
		if (scheduleTimer !== undefined) {
			clearTimeout(scheduleTimer);
			scheduleTimer = undefined;
		}
		abortWarm();
		latestRequest = undefined;
		replayRequest = undefined;
		requestStartedAt = 0;
		setStatus("idle");
	};

	const hasExpectedCacheWarmSavings = (
		model: ChatModelSelection,
		usage: ModelUsage
	): boolean => {
		const pricing = resolveModelMetadata(getPricingTable(), model);
		const savings = expectedCacheWarmSavingsUsd(pricing ?? undefined, usage);
		return savings !== null && savings >= MINIMUM_EXPECTED_SAVINGS_USD;
	};

	const persistWarmUsage = async (
		model: ChatModelSelection,
		usage: ModelUsage
	): Promise<void> => {
		const input: CreateSessionUsageEntryInput = {
			id: toSessionUsageEntryId(randomUUIDv7()),
			kind: "cache-warm",
			model,
			sessionId,
			usage,
		};
		const entry = await store.createSessionUsageEntry(input);
		usageEntries.set(entry.id, entry);
		notifyListeners();
	};

	const runWarm = async (
		request: ModelStepRequest,
		model: ChatModelSelection,
		startedAt: number,
		requestGeneration: number,
		controller: AbortController
	): Promise<boolean> => {
		try {
			const horizonRemainingMs =
				startedAt + MAX_WARMING_HORIZON_MS - Date.now();
			if (horizonRemainingMs <= 0) {
				return false;
			}
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(horizonRemainingMs),
			]);
			const usage = await warmModelRequest(request, modelClient, signal);
			if (usage === undefined) {
				return false;
			}
			await persistWarmUsage(model, usage);
			return hasExpectedCacheWarmSavings(model, usage);
		} catch {
			if (!controller.signal.aborted) {
				void logger.debug("Prompt cache warm request failed", {
					modelId: model.modelId,
					providerId: model.providerId,
				});
			}
			return false;
		} finally {
			if (generation === requestGeneration) {
				warmController = undefined;
			}
		}
	};

	const scheduleWarm = (schedule: CacheWarmSchedule): void => {
		const {
			delayMs,
			lastRefreshStartedAt,
			model,
			request,
			requestGeneration,
			requestStartedAt,
			ttlMs,
		} = schedule;
		const horizonEndsAt = requestStartedAt + MAX_WARMING_HORIZON_MS;
		const scheduledAt = lastRefreshStartedAt + delayMs;
		const latestSafeStartAt = lastRefreshStartedAt + ttlMs - WARMING_MARGIN_MS;
		const now = Date.now();
		if (
			scheduledAt >= horizonEndsAt ||
			now >= horizonEndsAt ||
			now > latestSafeStartAt
		) {
			return;
		}
		const remainingDelayMs = Math.max(0, scheduledAt - now);
		scheduleTimer = setTimeout(() => {
			scheduleTimer = undefined;
			if (generation !== requestGeneration) {
				return;
			}
			const warmStartedAt = Date.now();
			if (warmStartedAt >= horizonEndsAt || warmStartedAt > latestSafeStartAt) {
				setStatus("idle");
				return;
			}
			const controller = new AbortController();
			warmController = controller;
			setStatus("warming");
			const warming = runWarm(
				request,
				model,
				requestStartedAt,
				requestGeneration,
				controller
			)
				.then((refreshed) => {
					if (refreshed && generation === requestGeneration) {
						scheduleWarm({
							...schedule,
							lastRefreshStartedAt: warmStartedAt,
						});
					}
				})
				.finally(() => {
					if (activeWarm === warming) {
						activeWarm = undefined;
					}
					if (generation === requestGeneration && status === "warming") {
						setStatus("idle");
					}
				});
			activeWarm = warming;
		}, remainingDelayMs);
		setStatus("scheduled");
	};

	const onModelStepStarted = (
		request: ModelStepRequest | ChatRequest
	): void => {
		cancel();
		if (!("target" in request)) {
			// SDK turns invalidate legacy replay state but never replay through ModelClient.
			return;
		}
		latestRequest = request;
		requestStartedAt = Date.now();
		replayRequest = replayRequestSnapshot(request);
	};

	const onModelStepFinished = (
		request: ModelStepRequest | ChatRequest,
		usage: ModelUsage | undefined
	): void => {
		if (
			!("target" in request) ||
			request !== latestRequest ||
			usage === undefined ||
			replayRequest === undefined
		) {
			return;
		}
		const modelSelection: ChatModelSelection = {
			modelId: request.target.modelId,
			providerId: request.target.providerId,
		};
		const model = findSupportedChatModelSelection(modelSelection);
		if (model === null) {
			return;
		}
		const ttlMs = promptCacheRetentionTtlMsForModel(
			model,
			request.target.promptCacheRetention
		);
		if (ttlMs === undefined) {
			return;
		}
		const delayMs = computeCacheWarmDelayMs(ttlMs);
		if (delayMs === null) {
			return;
		}
		if (!hasExpectedCacheWarmSavings(modelSelection, usage)) {
			return;
		}
		const requestGeneration = generation;
		const startedAt = requestStartedAt;
		scheduleWarm({
			delayMs,
			lastRefreshStartedAt: startedAt,
			model: modelSelection,
			request: replayRequest,
			requestGeneration,
			requestStartedAt: startedAt,
			ttlMs,
		});
	};

	return {
		cancel,
		dispose: async () => {
			cancel();
			await activeWarm?.catch(() => undefined);
			listeners.clear();
		},
		getStatus: () => status,
		getUsageEntries: () => [...usageEntries.values()],
		modelStepObserver: { onModelStepFinished, onModelStepStarted },
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
