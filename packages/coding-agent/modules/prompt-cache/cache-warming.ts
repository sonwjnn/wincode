import type { ModelStepRequest } from "@wincode/ai/model-client";
import { createModelClient, warmModelRequest } from "@wincode/ai/model-client";
import type { ModelUsage } from "@wincode/ai/model-usage";
import { calculateModelUsageCostUsd } from "@wincode/ai/model-usage";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	promptCacheRetentionTtlMsForModel,
} from "@wincode/ai/models";
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
	onModelStepFinished: (
		request: ModelStepRequest,
		usage: ModelUsage | undefined
	) => void;
	onModelStepStarted: (request: ModelStepRequest) => void;
	subscribe: (listener: () => void) => () => void;
}>;

export type SessionCacheWarmingOptions = Readonly<{
	getPricingTable: () => ModelPricingTable;
	initialUsageEntries: readonly SessionUsageEntry[];
	sessionId: SessionId;
	store: Pick<SessionStore, "createSessionUsageEntry">;
}>;

const replayRequestSnapshot = (
	request: ModelStepRequest
): ModelStepRequest | undefined => {
	if (
		request.target.providerId === "google" ||
		request.googleCachedContent !== undefined ||
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
	): Promise<void> => {
		try {
			const horizonRemainingMs =
				startedAt + MAX_WARMING_HORIZON_MS - Date.now();
			if (horizonRemainingMs <= 0) {
				return;
			}
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(horizonRemainingMs),
			]);
			const usage = await warmModelRequest(request, modelClient, signal);
			if (usage !== undefined) {
				await persistWarmUsage(model, usage);
			}
		} catch {
			if (!controller.signal.aborted) {
				void logger.debug("Prompt cache warm request failed", {
					modelId: model.modelId,
					providerId: model.providerId,
				});
			}
		} finally {
			if (generation === requestGeneration) {
				warmController = undefined;
				setStatus("idle");
			}
		}
	};

	const onModelStepStarted = (request: ModelStepRequest): void => {
		cancel();
		latestRequest = request;
		requestStartedAt = Date.now();
		replayRequest = replayRequestSnapshot(request);
	};

	const onModelStepFinished = (
		request: ModelStepRequest,
		usage: ModelUsage | undefined
	): void => {
		if (
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
		const delayMs = ttlMs === undefined ? null : computeCacheWarmDelayMs(ttlMs);
		if (delayMs === null) {
			return;
		}
		const pricing = resolveModelMetadata(getPricingTable(), modelSelection);
		const savings = expectedCacheWarmSavingsUsd(pricing ?? undefined, usage);
		if (savings === null || savings < MINIMUM_EXPECTED_SAVINGS_USD) {
			return;
		}
		const requestGeneration = generation;
		const startedAt = requestStartedAt;
		const remainingDelayMs = delayMs - (Date.now() - startedAt);
		if (
			remainingDelayMs <= 0 ||
			startedAt + MAX_WARMING_HORIZON_MS <= Date.now()
		) {
			return;
		}
		const replay = replayRequest;
		scheduleTimer = setTimeout(() => {
			scheduleTimer = undefined;
			if (generation !== requestGeneration) {
				return;
			}
			const controller = new AbortController();
			warmController = controller;
			setStatus("warming");
			const warming = runWarm(
				replay,
				modelSelection,
				startedAt,
				requestGeneration,
				controller
			);
			activeWarm = warming;
			void warming.finally(() => {
				if (activeWarm === warming) {
					activeWarm = undefined;
				}
			});
		}, remainingDelayMs);
		setStatus("scheduled");
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
		onModelStepFinished,
		onModelStepStarted,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
