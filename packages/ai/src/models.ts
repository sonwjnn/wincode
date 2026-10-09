import { isString } from "@wincode/utils";
// Model selection over the Model Catalog. Catalog data, entry lookups, and
// types live in ./catalog; metadata that comes from the generated models.dev
// snapshot lives in ./model-metadata-runtime. This module is the selection
// surface callers already import, and it re-exports both so call sites keep
// one entry point.

import { z } from "zod";
import {
	type ChatModelSelection,
	connectionProviderIdSchema,
	findSupportedChatModel,
	findSupportedChatModelSelection,
	type SupportedChatModelId,
	type ThinkingLevel,
} from "./catalog";
import { isSupportedThinkingLevel } from "./model-metadata-runtime";

export * from "./catalog";
export * from "./model-metadata-runtime";

const modelSelectionBaseSchema = z.object({
	modelId: z
		.string()
		.transform((value): SupportedChatModelId => value as SupportedChatModelId),
	providerId: connectionProviderIdSchema,
});

export const modelSelectionSchema: z.ZodType<ChatModelSelection> =
	modelSelectionBaseSchema.superRefine((selection, context) => {
		if (!findSupportedChatModelSelection(selection)) {
			context.addIssue({
				code: "custom",
				message: `Unsupported model selection: ${selection.providerId}/${selection.modelId}`,
			});
		}
	});

export const defaultChatModel = {
	value: "gpt-5.6-luna" as SupportedChatModelId,
} as const;
export const defaultChatModelSelection = {
	modelId: defaultChatModel.value,
	providerId: "openai",
} as const satisfies ChatModelSelection;

/** Resolve the Agent config form `<connectionProviderId>/<modelId>`. */
export const parseCatalogModelSelection = (
	value: string
): ChatModelSelection | null => {
	const separatorIndex = value.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
		return null;
	}
	const selection = {
		modelId: value.slice(separatorIndex + 1),
		providerId: value.slice(0, separatorIndex),
	};
	const parsed = modelSelectionBaseSchema.safeParse(selection);
	return parsed.success && findSupportedChatModelSelection(parsed.data)
		? parsed.data
		: null;
};

export type AgentModelSelectionInput = Readonly<{
	model?: string;
	thinkingLevel?: ThinkingLevel;
}>;

export type AgentModelSelectionValidation = Readonly<{
	invalidModel: boolean;
	invalidThinkingLevel: boolean;
	model: ChatModelSelection | undefined;
}>;

/** Parses and validates an Agent's catalog-backed model and thinking level. */
export const resolveAgentModelSelection = ({
	model: modelName,
	thinkingLevel,
}: AgentModelSelectionInput): AgentModelSelectionValidation => {
	const parsedModel =
		modelName === undefined ? undefined : parseCatalogModelSelection(modelName);
	const model = parsedModel ?? undefined;
	return {
		invalidModel: modelName !== undefined && model === undefined,
		invalidThinkingLevel:
			thinkingLevel !== undefined &&
			(model === undefined || !isSupportedThinkingLevel(model, thinkingLevel)),
		model,
	};
};

export const getChatModelRoute = (
	selection: ChatModelSelection
): "direct" | null => findSupportedChatModelSelection(selection)?.route ?? null;

export const normalizeChatModelSelection = (
	selection: string | ChatModelSelection
): ChatModelSelection | null => {
	if (!isString(selection)) {
		const parsed = modelSelectionSchema.safeParse(selection);
		return parsed.success ? parsed.data : null;
	}
	const model = findSupportedChatModel(selection);
	return model
		? {
				modelId: model.id as SupportedChatModelId,
				providerId: model.connectionProviderId,
			}
		: null;
};

export const MODEL_VERSION_SUFFIX = /\s+\d{8}$/;

export const formatModelLabel = (displayName: string): string =>
	displayName.replace(MODEL_VERSION_SUFFIX, " (latest)");
