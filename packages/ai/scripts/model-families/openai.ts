import type { ModelMetadataEntry } from "../../src/model-metadata.ts";

// The Responses API documents explicit breakpoints, a 30-minute TTL, a
// 1,024 visible-token minimum, and optional accounting keys for GPT-5.6+.
// Keep these direct-OpenAI facts off proxy routes without published support.
// https://platform.openai.com/docs/guides/prompt-caching
const RESPONSES_PROMPT_CACHE = {
	explicit: { retentionTiers: ["short"] },
	protocols: {
		"openai-responses": {
			breakpoints: true,
			eligibility: { minimumInputTokens: 1024 },
			promptCacheKey: true,
			retention: {
				field: "prompt_cache_options.ttl",
				values: { short: "30m" },
			},
		},
	},
} as const;

/** Responses API cache facts apply to OpenAI's direct route, not proxies. */
export const openAIModelMetadataOverlays = {
	"openai/gpt-5.6": { promptCache: RESPONSES_PROMPT_CACHE },
	"openai/gpt-5.6-luna": { promptCache: RESPONSES_PROMPT_CACHE },
	"openai/gpt-5.6-sol": { promptCache: RESPONSES_PROMPT_CACHE },
	"openai/gpt-5.6-terra": { promptCache: RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-sol": { promptCache: RESPONSES_PROMPT_CACHE },
	"openai/gpt-6.1-sol": {
		promptCache: RESPONSES_PROMPT_CACHE,
		thinking: { levelMap: { off: null } },
	},
	"openai/gpt-6-luna": { promptCache: RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-terra": { promptCache: RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-astra": {
		promptCache: RESPONSES_PROMPT_CACHE,
		thinking: { levelMap: { off: null } },
	},
} satisfies Readonly<Record<string, ModelMetadataEntry>>;
