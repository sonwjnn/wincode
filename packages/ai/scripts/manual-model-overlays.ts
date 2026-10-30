import type { ModelMetadataEntry } from "../src/model-metadata.ts";
import { anthropicModelMetadataOverlays } from "./model-families/anthropic.ts";
import { deepSeekModelMetadataOverlays } from "./model-families/deepseek.ts";
import { googleModelMetadataOverlays } from "./model-families/google.ts";
import { openAIModelMetadataOverlays } from "./model-families/openai.ts";
import { openCodeGoModelMetadataOverlays } from "./provider-model-overlays/opencode-go.ts";

/** Documented model facts, grouped by family or hosting route. */
export const MANUAL_OVERLAYS = {
	...anthropicModelMetadataOverlays,
	...deepSeekModelMetadataOverlays,
	...googleModelMetadataOverlays,
	...openAIModelMetadataOverlays,
	...openCodeGoModelMetadataOverlays,
} satisfies Readonly<Record<string, ModelMetadataEntry>>;
