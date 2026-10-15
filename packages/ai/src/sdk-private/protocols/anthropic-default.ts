import { anthropicModelMetadataFor } from "../../anthropic-model-metadata.ts";
import { createAnthropicStrategy } from "./anthropic.ts";

export const anthropicStrategy = createAnthropicStrategy(
	anthropicModelMetadataFor
);
