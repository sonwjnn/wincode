import type { ModelMetadataEntry } from "../../src/model-metadata.ts";

/** Provider-route facts that do not generalize to the underlying model family. */
export const openCodeGoModelMetadataOverlays = {
	// Retain the last published models.dev facts while the manifest declares it.
	"opencode-go/grok-4.6": {
		cost: { input: 2, output: 6, cacheRead: 0.5 },
		limits: { context: 500_000, output: 500_000 },
		thinking: {
			levels: ["low", "medium", "high", "xhigh"],
			levelMap: { off: null },
		},
		tiers: [
			{
				inputTokensAbove: 200_000,
				input: 4,
				output: 12,
				cacheRead: 1,
			},
		],
	},
	"opencode-go/gpt-5.6-luna": { thinking: { levelMap: { off: null } } },
	"opencode-go/glm-5.3-flash": { thinking: { levelMap: { off: null } } },
	"opencode-go/glm-5.3": { thinking: { levelMap: { off: null } } },
	"opencode-go/glm-5.2": { thinking: { levelMap: { off: null } } },
	"opencode-go/kimi-k3": { thinking: { levelMap: { off: null } } },
	"opencode-go/muse-spark-1.3-contributor": {
		thinking: { levelMap: { off: null } },
	},
	"opencode-go/muse-spark-1.2-contributor": {
		thinking: { levelMap: { off: null } },
	},
	"opencode-go/kimi-k2.7-code": { thinking: { toggle: true } },
	"opencode-go/minimax-m2.7": { thinking: { toggle: true } },
	"opencode-go/mimo-v2.5": { thinking: { toggle: true } },
	"opencode-go/mimo-v2.5-pro": { thinking: { toggle: true } },
} satisfies Readonly<Record<string, ModelMetadataEntry>>;
