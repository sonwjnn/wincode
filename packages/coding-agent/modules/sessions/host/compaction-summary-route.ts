import type { ProviderCollection } from "@wincode/ai";
import { isPositiveSafeInteger } from "@wincode/utils";
import {
	type ProviderModelSelection,
	providerModelReasoningEffort,
	providerModelSelectionForProviderModel,
} from "@/modules/providers/provider-model-selection";
import type { SessionId } from "@/shared/identifiers";
import type { CompactionRequestInput } from "../compaction/compaction";
import { SessionCompactionError } from "../compaction/error";
import { resolveInvocableSummaryModel } from "../compaction/summary-generator";
import {
	type CompactionSummaryTarget,
	DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
} from "../compaction/types";
import { resolveContextWindowTokens } from "../usage/context-window";
import { assertPluginProviderSelectionOwner } from "./provider-selection-ownership";
import type { SessionCapabilities } from "./types";

const freezeSelection = (
	selection: ProviderModelSelection
): ProviderModelSelection =>
	Object.freeze({
		...selection,
		...(selection.pluginProviderSource === undefined
			? {}
			: {
					pluginProviderSource: Object.freeze({
						...selection.pluginProviderSource,
					}),
				}),
	});

/** Captures one immutable, invocable summary target for a Host compaction. */
export const resolveCompactionSummaryTarget = async (
	input: CompactionRequestInput,
	collection: ProviderCollection,
	capabilities: SessionCapabilities,
	sessionId: SessionId
): Promise<CompactionSummaryTarget> => {
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
	const contextWindowTokens = resolveContextWindowTokens(
		undefined,
		model.limits?.contextWindowTokens,
		input.settings.contextWindowOverrideTokens
	).tokens;
	const outputCeilingTokens = Math.floor(
		Math.min(
			policy?.maxOutputTokens ??
				input.settings.summaryMaxOutputTokens ??
				model.limits?.maxOutputTokens ??
				DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
			model.limits?.maxOutputTokens ?? Number.MAX_SAFE_INTEGER
		)
	);
	if (!isPositiveSafeInteger(outputCeilingTokens)) {
		throw new SessionCompactionError(
			"summary-failed",
			`Summary model ${model.providerId}/${model.modelId} has an invalid output-token ceiling.`
		);
	}
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
	return Object.freeze({
		model: freezeSelection(selection),
		contextWindowTokens,
		outputCeilingTokens,
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	});
};
