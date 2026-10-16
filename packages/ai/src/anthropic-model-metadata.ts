import { anthropicModelMetadataById } from "./generated/anthropic-model-metadata.generated.ts";
import type { ModelMetadataEntry } from "./model-metadata";
import type { ProviderModel } from "./sdk.ts";

export const anthropicModelMetadataFor = (
	model: Pick<ProviderModel, "modelId" | "providerId">
): ModelMetadataEntry | undefined =>
	model.providerId === "anthropic"
		? anthropicModelMetadataById[model.modelId]
		: undefined;
