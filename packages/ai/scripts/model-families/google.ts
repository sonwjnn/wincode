import type { ModelMetadataEntry } from "../../src/model-metadata.ts";

// Google's guide demonstrates CachedContent with Gemini 3.8 Flash and a
// 300-second TTL, and documents the one-hour default. Keep 3.6/3.7 and other
// TTLs absent until the API docs support them.
// https://ai.google.dev/gemini-api/docs/generate-content/caching
const CACHED_CONTENT_PROMPT_CACHE = {
	explicit: { retentionTiers: ["short", "long"] },
	googleCachedContent: { ttl: { short: "300s", long: "3600s" } },
} as const;

/** Gemini API documentation supports these exact model-level cache facts. */
export const googleModelMetadataOverlays = {
	"google/gemini-3-pro-preview": {
		thinking: { levels: ["low", "high"] },
	},
	"google/gemini-3.6-flash": { thinking: { levelMap: { off: null } } },
	"google/gemini-3.7-flash": { thinking: { levelMap: { off: null } } },
	"google/gemini-3.8-flash": {
		promptCache: CACHED_CONTENT_PROMPT_CACHE,
		thinking: { levelMap: { off: null } },
	},
} satisfies Readonly<Record<string, ModelMetadataEntry>>;
