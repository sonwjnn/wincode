import { anthropicModelMetadataById } from "./generated/anthropic-model-metadata.generated.ts";
import type { ModelMetadataEntry } from "./model-metadata";
import type { SupportedChatModel } from "./models";

export type AnthropicProtocolModel = SupportedChatModel &
	Readonly<{ modelMetadata?: ModelMetadataEntry }>;

export const withAnthropicModelMetadata = (
	model: SupportedChatModel,
	modelMetadata: ModelMetadataEntry | undefined
): AnthropicProtocolModel => ({ ...model, modelMetadata });

export const anthropicModelMetadataFor = (
	model: Pick<AnthropicProtocolModel, "id" | "modelMetadata" | "provider">
): ModelMetadataEntry | undefined =>
	model.modelMetadata ??
	(model.provider === "anthropic"
		? anthropicModelMetadataById[model.id]
		: undefined);
