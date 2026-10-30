import type { ModelMetadataEntry } from "../../src/model-metadata.ts";

/** DeepSeek effort facts are explicit per hosted model, not inferred from protocol. */
export const deepSeekModelMetadataOverlays = {
	"opencode-go/deepseek-v4.1-flash": {
		thinking: { levelMap: { off: null } },
	},
	"opencode-go/deepseek-v4-flash": {
		thinking: {
			levels: ["low", "high", "max"],
			levelMap: { minimal: null, medium: null, xhigh: null },
		},
	},
	"opencode-go/deepseek-v4-flash-vision-exp": {
		thinking: {
			levels: ["low", "high", "max"],
			levelMap: { minimal: null, medium: null, xhigh: null },
		},
	},
} satisfies Readonly<Record<string, ModelMetadataEntry>>;
