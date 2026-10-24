import type {
	ModelStepFinishedEvent,
	SessionContextMeasurement,
} from "@wincode/agent-core";
import { getModelContextTokens } from "@wincode/ai";
import {
	isSameProviderModelIdentity,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import { estimateCompactionTokens } from "../compaction/config";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionMessage } from "../message";

/** Append-only content keeps its epoch; replacing context starts another one. */
export const getSessionContextEpoch = (
	messages: readonly { id: string }[]
): string =>
	messages.findLast((message) => isCompactionSummaryMessage(message))?.id ??
	"initial";

/** Tool results follow the measured response. Without exact coverage, estimate instead. */
export const contextMeasurementForStep = (
	event: ModelStepFinishedEvent,
	epoch: string,
	hasToolCalls: boolean
): SessionContextMeasurement | undefined =>
	!hasToolCalls && event.usage
		? { epoch, stepId: event.stepId, usage: event.usage }
		: undefined;

export type SessionContextUsage = {
	lastUsageIndex: number;
	providerTokens: number | null;
	tokens: number;
	trailingTokens: number;
	source: "measured" | "mixed" | "estimated";
};

const estimateSessionContextUsage = (
	messages: readonly SessionMessage[],
	estimateTokens: (messages: readonly SessionMessage[]) => number,
	model: ProviderModelSelection | undefined,
	acceptForeignModelMeasurements: boolean
): SessionContextUsage => {
	const epoch = getSessionContextEpoch(messages);
	let lastUsageIndex = -1;
	let providerTokens: number | null = null;
	let lastMeasurementMatchesModel = true;
	for (const [index, message] of messages.entries()) {
		const sample = message.metadata?.contextMeasurement;
		const measurementModel = message.metadata?.model;
		if (
			message.role !== "assistant" ||
			!sample ||
			sample.epoch !== epoch ||
			(model &&
				!(
					measurementModel &&
					(acceptForeignModelMeasurements ||
						isSameProviderModelIdentity(model, measurementModel))
				))
		) {
			continue;
		}
		lastUsageIndex = index;
		providerTokens = getModelContextTokens(sample.usage);
		lastMeasurementMatchesModel =
			model === undefined ||
			(measurementModel !== undefined &&
				isSameProviderModelIdentity(model, measurementModel));
	}
	const suffix =
		lastUsageIndex === -1 ? messages : messages.slice(lastUsageIndex + 1);
	const trailingTokens = suffix.length === 0 ? 0 : estimateTokens(suffix);
	let source: SessionContextUsage["source"] = "estimated";
	if (providerTokens !== null) {
		source =
			suffix.length === 0 && lastMeasurementMatchesModel ? "measured" : "mixed";
	}
	return {
		lastUsageIndex,
		providerTokens,
		tokens: Math.max(0, (providerTokens ?? 0) + trailingTokens),
		trailingTokens,
		source,
	};
};

/** Restricts occupancy measurements to the selected Provider Model when supplied. */
export const estimateSessionContextTokens = (
	messages: readonly SessionMessage[],
	estimateTokens: (
		messages: readonly SessionMessage[]
	) => number = estimateCompactionTokens,
	model?: ProviderModelSelection
): SessionContextUsage =>
	estimateSessionContextUsage(messages, estimateTokens, model, false);

/** Uses the latest same-epoch Provider measurement as a threshold baseline across model switches. */
export const estimateSessionContextTokensForThreshold = (
	messages: readonly SessionMessage[],
	estimateTokens: (
		messages: readonly SessionMessage[]
	) => number = estimateCompactionTokens,
	model?: ProviderModelSelection
): SessionContextUsage =>
	estimateSessionContextUsage(messages, estimateTokens, model, true);
