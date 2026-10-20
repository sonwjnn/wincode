import { type ModelStepObserver, toModelId } from "@wincode/agent-core";
import type {
	ChatRequest,
	ProviderCollection,
	ProviderModel,
} from "@wincode/ai";
import {
	calculateModelUsageCostUsd,
	type ModelUsage,
	normalizeModelUsage,
} from "@wincode/ai";
import { logger } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import {
	type ModelPricingEntry,
	pricingEntryForProviderModel,
} from "@/modules/model-pricing/model-pricing";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type {
	CreateSessionUsageEntryInput,
	SessionStore,
	SessionUsageEntry,
} from "@/modules/sessions/storage/session-store";
import { type SessionId, toSessionUsageEntryId } from "@/shared/identifiers";

const WARMING_MARGIN_MS = 10_000;
const MAX_WARMING_HORIZON_MS = 60 * 60_000;
const MINIMUM_EXPECTED_SAVINGS_USD = 0.05;
const CACHE_WARM_OUTPUT_TOKEN_CAP = 1;

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
	usage: ModelUsage,
	warmReplayOutputTokens: number
): number | null => {
	const cachedPrefixTokens =
		(usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
	if (
		!Number.isSafeInteger(warmReplayOutputTokens) ||
		warmReplayOutputTokens < 0 ||
		cachedPrefixTokens <= 0 ||
		cachedPrefixTokens > usage.inputTokens
	) {
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
		outputTokens: warmReplayOutputTokens,
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
	initialUsageEntries: readonly SessionUsageEntry[];
	providerCollection: ProviderCollection;
	sessionId: SessionId;
	store: Pick<SessionStore, "createSessionUsageEntry">;
}>;

type CacheWarmReplayRequest = Readonly<{
	kind: "provider-sdk";
	model: ProviderModelSelection;
	providerCollection: ProviderCollection;
	providerModel: ProviderModel;
	request: ChatRequest;
	ttlMs: number;
}>;

type CacheWarmSchedule = Readonly<{
	delayMs: number;
	lastRefreshStartedAt: number;
	replay: CacheWarmReplayRequest;
	requestGeneration: number;
	requestStartedAt: number;
}>;

const providerSdkReplayRequestSnapshot = (
	request: ChatRequest,
	providerCollection: ProviderCollection
): CacheWarmReplayRequest | undefined => {
	const retention = request.cacheRetention;
	const providerModel = providerCollection.getModel(
		request.providerId,
		request.modelId
	);
	const modelSelection: ProviderModelSelection = {
		modelId: toModelId(request.modelId),
		providerId: request.providerId,
	};
	const ttlMs =
		retention === undefined
			? undefined
			: providerModel?.promptCacheRetentionTtlMs?.[retention];
	if (
		providerModel === undefined ||
		retention === undefined ||
		!providerModel.promptCacheRetentionTiers?.includes(retention) ||
		ttlMs === undefined
	) {
		return;
	}
	const { signal: _signal, ...requestWithoutSignal } = request;
	try {
		return {
			kind: "provider-sdk",
			model: modelSelection,
			providerCollection,
			providerModel,
			request: structuredClone(requestWithoutSignal),
			ttlMs,
		};
	} catch {
		// Requests with opaque values that cannot be faithfully snapshotted are
		// not eligible for replay.
		return;
	}
};

/** One Session-owned best-effort warmer with a separate durable cost path. */
export const createSessionCacheWarming = ({
	initialUsageEntries,
	providerCollection,
	sessionId,
	store,
}: SessionCacheWarmingOptions): SessionCacheWarming => {
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
	let latestRequest: ChatRequest | undefined;
	let replayRequest: CacheWarmReplayRequest | undefined;
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
		replay: CacheWarmReplayRequest,
		usage: ModelUsage,
		warmReplayOutputTokens: number
	): boolean => {
		const pricing = pricingEntryForProviderModel(replay.providerModel);
		const savings = expectedCacheWarmSavingsUsd(
			pricing,
			usage,
			warmReplayOutputTokens
		);
		return savings !== null && savings >= MINIMUM_EXPECTED_SAVINGS_USD;
	};

	const persistWarmUsage = async (
		model: ProviderModelSelection,
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

	const warmProviderSdkRequest = async (
		replay: Extract<CacheWarmReplayRequest, { kind: "provider-sdk" }>,
		signal: AbortSignal
	): Promise<ModelUsage | undefined> => {
		const {
			cacheWarming: _cacheWarming,
			reasoningEffort: _reasoningEffort,
			signal: _requestSignal,
			...request
		} = replay.request;
		if (
			!(await replay.providerCollection.canEnforceMaxOutputTokens(
				replay.providerModel.providerId,
				replay.providerModel.modelId
			))
		) {
			return;
		}
		let usage: ModelUsage | undefined;
		let succeeded = false;
		for await (const event of replay.providerCollection.chat({
			...request,
			cacheWarming: true,
			maxOutputTokens: CACHE_WARM_OUTPUT_TOKEN_CAP,
			signal,
		})) {
			if (event.type === "usage") {
				usage = normalizeModelUsage(event.usage) ?? undefined;
			} else if (event.type === "terminal") {
				succeeded = event.outcome.status === "success";
			}
		}
		return succeeded ? usage : undefined;
	};

	const runWarm = async (
		replay: CacheWarmReplayRequest,
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
			const usage = await warmProviderSdkRequest(replay, signal);
			if (usage === undefined) {
				return false;
			}
			await persistWarmUsage(replay.model, usage);
			return hasExpectedCacheWarmSavings(replay, usage, usage.outputTokens);
		} catch {
			if (!controller.signal.aborted) {
				void logger.debug("Prompt cache warm request failed", {
					modelId: replay.model.modelId,
					providerId: replay.model.providerId,
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
			replay,
			requestGeneration,
			requestStartedAt,
		} = schedule;
		const ttlMs = replay.ttlMs;
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
				replay,
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

	const onModelStepStarted = (request: ChatRequest): void => {
		cancel();
		latestRequest = request;
		requestStartedAt = Date.now();
		replayRequest = providerSdkReplayRequestSnapshot(
			request,
			providerCollection
		);
	};

	const onModelStepFinished = (
		request: ChatRequest,
		usage: ModelUsage | undefined
	): void => {
		if (
			request !== latestRequest ||
			usage === undefined ||
			replayRequest === undefined
		) {
			return;
		}
		const delayMs = computeCacheWarmDelayMs(replayRequest.ttlMs);
		if (
			delayMs === null ||
			!hasExpectedCacheWarmSavings(
				replayRequest,
				usage,
				CACHE_WARM_OUTPUT_TOKEN_CAP
			)
		) {
			return;
		}
		const requestGeneration = generation;
		const startedAt = requestStartedAt;
		scheduleWarm({
			delayMs,
			lastRefreshStartedAt: startedAt,
			replay: replayRequest,
			requestGeneration,
			requestStartedAt: startedAt,
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
