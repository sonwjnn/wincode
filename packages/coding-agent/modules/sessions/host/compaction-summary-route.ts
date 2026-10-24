import type { ProviderCollection } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
import {
	providerModelReasoningEffort,
	providerModelSelectionForProviderModel,
} from "@/modules/providers/provider-model-selection";
import type { SessionId } from "@/shared/identifiers";
import type { CompactSessionInput } from "../compaction/compaction";
import { SessionCompactionError } from "../compaction/error";
import { resolveSummaryModelCapability } from "../compaction/summary-generator";
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
	const resolved = await resolveSummaryModelCapability(collection, selection);
	if (resolved.model === undefined) {
		if (!resolved.deferrable) {
			// An unknown or unauthenticated configured target stays a hard error;
			// a Plugin handoff must not mask a broken summary configuration.
			throw new SessionCompactionError("summary-failed", resolved.failure);
		}
		// A Plugin may supply the handoff instead of generating one, so this
		// capability failure is deferred to where generation is needed.
		// Chat thinking never becomes summary thinking; only an explicit policy
		// selection is retained for provenance.
		const { thinkingLevel: _chatThinking, ...request } = input;
		return {
			...request,
			summaryModel: selection,
			summaryModelFailure: resolved.failure,
			settings: {
				...input.settings,
				summaryMaxOutputTokens:
					policy?.maxOutputTokens ??
					input.settings.summaryMaxOutputTokens ??
					DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
			},
			...omitUndefined({ thinkingLevel: policy?.thinkingLevel }),
		};
	}
	const { model } = resolved;
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
