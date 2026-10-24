import type { ProviderCollection } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
import {
	providerModelReasoningEffort,
	providerModelSelectionForProviderModel,
} from "@/modules/providers/provider-model-selection";
import type { SessionId } from "@/shared/identifiers";
import type { CompactSessionInput } from "../compaction/compaction";
import { SessionCompactionError } from "../compaction/error";
import {
	requireInvocableProviderModel,
	requireSummaryOutputCapability,
} from "../compaction/summary-generator";
import { DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS } from "../compaction/types";
import { assertPluginProviderSelectionOwner } from "./agent-session-turn-runner";
import type { SessionCapabilities } from "./types";

/** Captures the trusted summary target without replacing conversation policy. */
export const resolveCompactionSummaryRoute = async (
	input: CompactSessionInput,
	collection: ProviderCollection,
	capabilities: SessionCapabilities,
	sessionId: SessionId
): Promise<CompactSessionInput> => {
	const policy = input.settings.summary;
	if (policy?.error !== undefined) {
		throw new SessionCompactionError("summary-failed", policy.error);
	}
	const configured = policy?.model;
	const owner =
		configured === undefined
			? undefined
			: capabilities
					.getPluginRuntime?.()
					?.getProviderRegistrations(sessionId)
					.find(({ providerId }) => providerId === configured.providerId);
	const selection =
		configured === undefined
			? input.model
			: providerModelSelectionForProviderModel(
					configured,
					owner === undefined
						? undefined
						: { pluginId: owner.pluginId, sourceIdentity: owner.sourceIdentity }
				);
	assertPluginProviderSelectionOwner(
		selection,
		capabilities,
		collection,
		sessionId
	);
	const model = await requireInvocableProviderModel(collection, selection);
	await requireSummaryOutputCapability(collection, model);
	const contextLimit = model.limits?.contextWindowTokens;
	if (
		contextLimit === undefined ||
		!Number.isSafeInteger(contextLimit) ||
		contextLimit <= 0
	) {
		throw new SessionCompactionError(
			"summary-failed",
			`Cannot verify the summary budget for ${model.providerId}/${model.modelId}: its context-window limit is unavailable. Configure compaction.summary.model with a known context window.`
		);
	}
	const thinkingLevel =
		policy?.thinkingLevel ?? providerModelReasoningEffort(model, "off");
	if (
		thinkingLevel !== undefined &&
		providerModelReasoningEffort(model, thinkingLevel) === undefined
	) {
		throw new SessionCompactionError(
			"summary-failed",
			`Summary model ${model.providerId}/${model.modelId} does not support thinkingLevel ${thinkingLevel}. Correct compaction.summary.thinkingLevel.`
		);
	}
	const { thinkingLevel: _chatThinking, ...request } = input;
	return {
		...request,
		summaryModel: selection,
		...omitUndefined({ thinkingLevel }),
		settings: {
			...input.settings,
			summaryContextLimit: contextLimit,
			summaryMaxOutputTokens: Math.min(
				policy?.maxOutputTokens ??
					input.settings.summaryMaxOutputTokens ??
					DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
				model.limits?.maxOutputTokens ?? Number.MAX_SAFE_INTEGER
			),
		},
	};
};
