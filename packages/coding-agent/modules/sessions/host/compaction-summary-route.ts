import type { ProviderCollection } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
import {
	providerModelReasoningEffort,
	providerModelSelectionForProviderModel,
} from "@/modules/providers/provider-model-selection";
import type { SessionId } from "@/shared/identifiers";
import type { CompactSessionInput } from "../compaction/compaction";
import { SessionCompactionError } from "../compaction/error";
import { resolveInvocableSummaryModel } from "../compaction/summary-generator";
import { DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS } from "../compaction/types";
import { resolveContextWindowTokens } from "../usage/context-window";
import { assertPluginProviderSelectionOwner } from "./agent-session-turn-runner";
import type { SessionPluginProviderTrustCapabilities } from "./types";

/** Captures the trusted summary target without replacing conversation policy. */
export const resolveCompactionSummaryRoute = async (
	input: CompactSessionInput,
	collection: ProviderCollection,
	capabilities: SessionPluginProviderTrustCapabilities,
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
	const resolved = await resolveInvocableSummaryModel(collection, selection);
	if (resolved.model === undefined) {
		// A Plugin handoff must not hide an unknown or unauthenticated target.
		throw new SessionCompactionError("summary-failed", resolved.failure);
	}
	const { model } = resolved;
	const contextLimit = resolveContextWindowTokens(
		undefined,
		model.limits?.contextWindowTokens,
		input.settings.contextWindowOverrideTokens
	).tokens;
	const thinkingLevel = input.thinkingLevel;
	if (
		thinkingLevel !== undefined &&
		providerModelReasoningEffort(model, thinkingLevel) === undefined
	) {
		throw new SessionCompactionError(
			"summary-failed",
			`Summary model ${model.providerId}/${model.modelId} does not support the active Session thinking level ${thinkingLevel}. Select a summary model that supports it.`
		);
	}
	return {
		...input,
		summaryModel: selection,
		...omitUndefined({ thinkingLevel }),
		settings: {
			...input.settings,
			summaryContextLimit: contextLimit,
			summaryMaxOutputTokens: Math.min(
				policy?.maxOutputTokens ??
					input.settings.summaryMaxOutputTokens ??
					model.limits?.maxOutputTokens ??
					DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
				model.limits?.maxOutputTokens ?? Number.MAX_SAFE_INTEGER
			),
		},
	};
};
