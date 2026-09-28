import { isUndefined } from "@wincode/runtime-utils";
// Read path over the generated model metadata snapshot. Kept separate from
// ./catalog so the catalog stays a compile-time constant that cannot depend on
// generated output, and so removal of the snapshot never breaks selection.

import {
	type ChatModelSelection,
	effortSchema,
	findSupportedChatModelSelection,
	reasoningModeSchema,
	type SupportedChatModel,
	supportsSelectableReasoning,
} from "./catalog";
import { modelMetadataByKey } from "./generated/model-metadata.generated";
import type {
	Effort,
	ModelMetadataEntry,
	ReasoningMode,
	ReasoningSelection,
} from "./model-metadata";

export { modelMetadataSnapshotDate } from "./generated/model-metadata.generated";

/** Builds one mutually exclusive Effort or Reasoning Mode selection. */
export const createReasoningSelection = (
	effort: Effort | undefined,
	reasoningMode: ReasoningMode | undefined
): ReasoningSelection => {
	if (effort !== undefined && reasoningMode !== undefined) {
		throw new Error("Select either an Effort or a Reasoning Mode, not both.");
	}
	if (effort !== undefined) {
		return { effort };
	}
	if (reasoningMode !== undefined) {
		return { reasoningMode };
	}
	return {};
};

export const getModelMetadata = (
	model: SupportedChatModel | null
): ModelMetadataEntry | undefined =>
	model ? modelMetadataByKey[`${model.provider}/${model.id}`] : undefined;

/**
 * The named Efforts a model publishes. Toggle states are deliberately absent;
 * a budget-only model keeps its derived automatic budget without a choice.
 */
const getSupportedEffortsForModel = (
	model: SupportedChatModel | null
): readonly Effort[] => {
	if (!model) {
		return [];
	}
	if (!supportsSelectableReasoning(model)) {
		return [];
	}
	const policy = getModelMetadata(model)?.thinking;
	return policy?.unlevelled ? [] : (policy?.levels ?? []);
};

/** Available off/on controls are determined by the model's declared toggle. */
const getSupportedModesForModel = (
	model: SupportedChatModel | null
): readonly ReasoningMode[] => {
	if (!model) {
		return [];
	}
	if (!supportsSelectableReasoning(model)) {
		return [];
	}
	const policy = getModelMetadata(model)?.thinking;
	if (!policy?.toggle || policy.unlevelled) {
		return [];
	}
	return policy.levels?.length ? ["none"] : ["none", "thinking"];
};

export const getSupportedModelEfforts = (
	selection: ChatModelSelection
): readonly Effort[] =>
	getSupportedEffortsForModel(findSupportedChatModelSelection(selection));

export const getSupportedReasoningModes = (
	selection: ChatModelSelection
): readonly ReasoningMode[] =>
	getSupportedModesForModel(findSupportedChatModelSelection(selection));

export const isSupportedModelEffort = (
	selection: ChatModelSelection,
	effort: Effort
): boolean => getSupportedModelEfforts(selection).includes(effort);

export const isSupportedReasoningMode = (
	selection: ChatModelSelection,
	reasoningMode: ReasoningMode
): boolean => getSupportedReasoningModes(selection).includes(reasoningMode);

export const normalizeModelEffort = (
	selection: ChatModelSelection,
	effort: string | undefined
): Effort | undefined =>
	normalizeModelEffortForModel(
		findSupportedChatModelSelection(selection),
		effort
	);

export const normalizeModelEffortForModel = (
	model: SupportedChatModel | null,
	effort: string | undefined
): Effort | undefined => {
	if (isUndefined(effort)) {
		return;
	}
	const parsed = effortSchema.safeParse(effort);
	return parsed.success &&
		getSupportedEffortsForModel(model).includes(parsed.data)
		? parsed.data
		: undefined;
};

export const normalizeReasoningMode = (
	selection: ChatModelSelection,
	reasoningMode: string | undefined
): ReasoningMode | undefined =>
	normalizeReasoningModeForModel(
		findSupportedChatModelSelection(selection),
		reasoningMode
	);

export const normalizeReasoningModeForModel = (
	model: SupportedChatModel | null,
	reasoningMode: string | undefined
): ReasoningMode | undefined => {
	if (isUndefined(reasoningMode)) {
		return;
	}
	const parsed = reasoningModeSchema.safeParse(reasoningMode);
	return parsed.success &&
		getSupportedModesForModel(model).includes(parsed.data)
		? parsed.data
		: undefined;
};

/** Normalizes a mutually exclusive Effort or Reasoning Mode for one model. */
export const normalizeReasoningSelection = (
	selection: ChatModelSelection,
	choice: ReasoningSelection
): ReasoningSelection => {
	if (choice.effort !== undefined) {
		const effort = normalizeModelEffort(selection, choice.effort);
		return effort === undefined ? {} : { effort };
	}
	if (choice.reasoningMode !== undefined) {
		const reasoningMode = normalizeReasoningMode(
			selection,
			choice.reasoningMode
		);
		return reasoningMode === undefined ? {} : { reasoningMode };
	}
	return {};
};
