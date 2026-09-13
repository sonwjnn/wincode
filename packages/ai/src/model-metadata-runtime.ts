// Read path over the generated model metadata snapshot. Kept separate from
// ./catalog so the catalog stays a compile-time constant that cannot depend on
// generated output, and so removal of the snapshot never breaks selection.

import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	modelVariantSchema,
	type SupportedChatModel,
	supportsReasoningVariants,
} from "./catalog";
import { modelMetadataByKey } from "./generated/model-metadata.generated";
import type {
	ModelMetadataEntry,
	ModelThinkingPolicy,
	ModelVariant,
} from "./model-metadata";

export { modelMetadataSnapshotDate } from "./generated/model-metadata.generated";

/**
 * Metadata for one catalog entry, resolved from the generated models.dev
 * snapshot. An entry absent from the snapshot carries no metadata, which is
 * reported by the generator rather than fabricated here.
 */
export const getModelMetadata = (
	model: SupportedChatModel
): ModelMetadataEntry | undefined =>
	modelMetadataByKey[`${model.connectionProviderId}/${model.id}`];

/**
 * The levels a user may pick for a model. The published ladder when there is
 * one, both `"none"` and `"thinking"` for a toggle-only model, and nothing at
 * all for a model with no reasoning policy.
 *
 * `"thinking"` is not a published level: it exists because the catalog's level
 * vocabulary has no other way to name "on, at the provider's default effort".
 * It is therefore offered only when there is no ladder to name an effort with.
 */
export const getSupportedModelVariants = (
	selection: ChatModelSelection
): readonly ModelVariant[] => {
	const model = findSupportedChatModelSelection(selection);
	if (!(model && supportsReasoningVariants(model))) {
		return [];
	}
	const policy = getModelMetadata(model)?.thinking;
	if (!policy) {
		return [];
	}
	if (policy.levels && policy.levels.length > 0) {
		return policy.toggle
			? (["none", ...policy.levels] as const)
			: policy.levels;
	}
	// A switch-only model offers both states. A budget-only model has no
	// user-selectable level: its budget is derived from the request.
	if (policy.unlevelled) {
		return [];
	}
	return policy.toggle
		? (["none", "thinking"] as const)
		: (["thinking"] as const);
};

/** Whether `level` is one of the levels this model's policy publishes. */
const policyAdmits = (
	policy: ModelThinkingPolicy,
	level: ModelVariant
): boolean => {
	if (policy.levels?.includes(level)) {
		return true;
	}
	// An unresolvable variant value still reaches the resolver as `undefined`,
	// and `"none"` is how a caller asks for reasoning off without naming an
	// effort. Both are only legal where reasoning has an on/off dimension.
	if (level === "none") {
		return policy.toggle === true;
	}
	if (level === "thinking") {
		return (
			policy.toggle === true &&
			!policy.unlevelled &&
			(policy.levels === undefined || policy.levels.length === 0)
		);
	}
	return false;
};

export const isSupportedModelVariant = (
	selection: ChatModelSelection,
	variant: ModelVariant
): boolean => getSupportedModelVariants(selection).includes(variant);

export const normalizeModelVariant = (
	selection: ChatModelSelection,
	variant: string | undefined
): ModelVariant | undefined =>
	normalizeModelVariantForModel(
		findSupportedChatModelSelection(selection),
		variant
	);

/** Validate variant against the selected catalog entry, not its runtime provider. */
export const normalizeModelVariantForModel = (
	model: SupportedChatModel | null,
	variant: string | undefined
): ModelVariant | undefined => {
	if (variant === undefined || !model || !supportsReasoningVariants(model)) {
		return;
	}
	const parsed = modelVariantSchema.safeParse(variant);
	const policy = getModelMetadata(model)?.thinking;
	return parsed.success && policy && policyAdmits(policy, parsed.data)
		? parsed.data
		: undefined;
};
