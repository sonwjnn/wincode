import { type ModelId, toModelId } from "@wincode/agent-core";
import type { ChatModelSelection, ThinkingLevel } from "@wincode/ai/models";
import {
	modelSelectionSchema,
	normalizeThinkingSelection,
	type ThinkingSelection,
} from "@wincode/ai/models";
import type {
	ChatReasoningEffort,
	ProviderModel,
	ProviderModelSelection as SdkProviderModelSelection,
} from "@wincode/ai/sdk";
import { z } from "zod";

/** A provider-neutral Session model identity, distinct from Catalog selection. */
export type ProviderModelSelection = SdkProviderModelSelection &
	Readonly<{ modelId: ModelId }>;

const nonEmptyIdentity = z.string().refine((value) => value.trim().length > 0);

/** Validates exact provider/model identities without imposing the legacy Catalog allowlist. */
export const providerModelSelectionSchema = z
	.object({
		modelId: nonEmptyIdentity.transform((value) => toModelId(value)),
		providerId: nonEmptyIdentity,
	})
	.strict();

/** Normalizes stored Session identities while preserving unknown Provider Models. */
export const normalizeProviderModelSelection = (
	value: unknown
): ProviderModelSelection | null => {
	const parsed = providerModelSelectionSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
};

/** Requires exact Provider and Model identity; Catalog aliases are not substitutes. */
export const isAvailableProviderModelSelection = (
	selection: ProviderModelSelection,
	models: readonly ProviderModel[]
): boolean =>
	models.some(
		(model) =>
			model.providerId === selection.providerId &&
			model.modelId === selection.modelId
	);

/** Parses an Agent's `<providerId>/<modelId>` identity without catalog lookup. */
export const parseProviderModelSelection = (
	value: string
): ProviderModelSelection | null => {
	const separatorIndex = value.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
		return null;
	}
	return normalizeProviderModelSelection({
		modelId: value.slice(separatorIndex + 1),
		providerId: value.slice(0, separatorIndex),
	});
};

/** Returns the old Catalog-backed selection only when it remains a known Catalog entry. */
export const catalogSelectionForProviderModel = (
	selection: ProviderModelSelection
): ChatModelSelection | null => {
	const parsed = modelSelectionSchema.safeParse(selection);
	return parsed.success ? parsed.data : null;
};

/** Normalizes one selected level against the current Provider Model declaration. */
export const providerModelReasoningEffort = (
	model: ProviderModel,
	thinkingLevel: ThinkingLevel | undefined
): ChatReasoningEffort | undefined => {
	if (thinkingLevel === undefined) {
		return;
	}
	const effort = thinkingLevel === "off" ? "none" : thinkingLevel;
	return model.reasoningEfforts?.includes(effort) ? effort : undefined;
};

/** The selectable Thinking Levels a Provider Model explicitly declares. */
export const supportedProviderThinkingLevels = (
	model: ProviderModel
): readonly ThinkingLevel[] =>
	(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).filter(
		(level) => providerModelReasoningEffort(model, level) !== undefined
	);

/** Keeps Thinking Levels only for metadata explicitly declared by a Provider Model. */
export const normalizeProviderModelThinkingSelection = (
	model: ProviderModel,
	selection: ThinkingSelection
): ThinkingSelection =>
	providerModelReasoningEffort(model, selection.thinkingLevel) === undefined
		? {}
		: { thinkingLevel: selection.thinkingLevel };

/** Keeps legacy Catalog-backed Thinking Levels for the unmigrated model path. */
export const normalizeProviderThinkingSelection = (
	model: ProviderModelSelection,
	selection: ThinkingSelection
): ThinkingSelection => {
	const catalogModel = catalogSelectionForProviderModel(model);
	return catalogModel === null
		? selection
		: normalizeThinkingSelection(catalogModel, selection);
};
