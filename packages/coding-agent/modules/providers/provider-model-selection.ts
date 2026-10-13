import { type ModelId, toModelId } from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import {
	modelSelectionSchema,
	normalizeThinkingSelection,
	type ThinkingSelection,
} from "@wincode/ai/models";
import { z } from "zod";

/** A provider-neutral Session model identity, distinct from Catalog selection. */
export type ProviderModelSelection = Readonly<{
	modelId: ModelId;
	providerId: string;
}>;

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

/** Returns the old Catalog-backed selection only when it remains a known Catalog entry. */
export const catalogSelectionForProviderModel = (
	selection: ProviderModelSelection
): ChatModelSelection | null => {
	const parsed = modelSelectionSchema.safeParse(selection);
	return parsed.success ? parsed.data : null;
};

/** Keeps Thinking Levels only for models whose Catalog declares that support. */
export const normalizeProviderThinkingSelection = (
	model: ProviderModelSelection,
	selection: ThinkingSelection
): ThinkingSelection => {
	const catalogModel = catalogSelectionForProviderModel(model);
	return catalogModel === null
		? {}
		: normalizeThinkingSelection(catalogModel, selection);
};
