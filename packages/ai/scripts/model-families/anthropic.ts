import type { ModelMetadataEntry } from "../../src/model-metadata.ts";

// Anthropic documents explicit prompt caching for active Claude API models,
// with five-minute and one-hour retention. OpenCode Go is intentionally absent
// because its proxy route's cache capabilities are not documented by Anthropic.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const EXPLICIT_PROMPT_CACHE = {
	explicit: { retentionTiers: ["short", "long"] },
} as const;

/** Anthropic documents these cache tiers for the direct Claude API route. */
export const anthropicModelMetadataOverlays = {
	"anthropic/claude-opus-5.5": { promptCache: EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-opus-4-5": { promptCache: EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-opus-4-5-20251101": {
		promptCache: EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-opus-4-7": { promptCache: EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-sonnet-5": { promptCache: EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-opus-4-8": { promptCache: EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-fable-5": {
		promptCache: EXPLICIT_PROMPT_CACHE,
		thinking: { levelMap: { off: null } },
	},
	"anthropic/claude-fable-5-1": {
		promptCache: EXPLICIT_PROMPT_CACHE,
		thinking: { levelMap: { off: null } },
	},
	"anthropic/claude-opus-5": {
		promptCache: EXPLICIT_PROMPT_CACHE,
		thinking: { levelMap: { off: null } },
	},
	"anthropic/claude-opus-4-6": { promptCache: EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-sonnet-4-6": {
		promptCache: EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-haiku-4-5": {
		promptCache: EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-haiku-4-5-20251001": {
		promptCache: EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-sonnet-4-5": {
		promptCache: EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-sonnet-4-5-20250929": {
		promptCache: EXPLICIT_PROMPT_CACHE,
	},
} satisfies Readonly<Record<string, ModelMetadataEntry>>;
