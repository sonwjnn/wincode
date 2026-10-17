// Combines manifest-declared Provider Models with exact models.dev facts and
// manual overlays. Fetching and file generation live in sync-provider-model-catalog.ts.

import type { ModelMetadataEntry } from "../src/model-metadata";
import { metadataForModel } from "../src/models-dev";
import { modelsDevBlocksFromPayload } from "../src/models-dev-payload";
import { withProviderModelMetadata } from "../src/provider-model-metadata.ts";
import type { ProviderModel } from "../src/sdk.ts";

// Anthropic documents explicit prompt caching for all active Claude models
// on the Claude API, with 5-minute and 1-hour retention. The OpenCode Go models
// are intentionally absent because their provider-specific cache capabilities
// are not published by Anthropic. Source:
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const ANTHROPIC_EXPLICIT_PROMPT_CACHE = {
	explicit: { retentionTiers: ["short", "long"] },
} as const;

// Gemini's Generate Content caching guide demonstrates CachedContent with
// Gemini 3.8 Flash and a 300-second TTL, and documents the one-hour default.
// Keep 3.6/3.7 and other TTLs absent until Google's Gemini API docs support them.
// https://ai.google.dev/gemini-api/docs/generate-content/caching
const GOOGLE_CACHED_CONTENT_PROMPT_CACHE = {
	explicit: { retentionTiers: ["short", "long"] },
	googleCachedContent: { ttl: { short: "300s", long: "3600s" } },
} as const;

// OpenAI's Responses API documents explicit breakpoints, 30-minute TTL, a
// 1,024 visible-token minimum, and optional accounting keys for GPT-5.6 and
// later. Do not apply this overlay to OpenCode Go: its proxy route's support
// for these controls is not documented by OpenAI.
const OPENAI_RESPONSES_PROMPT_CACHE = {
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

/** Facts models.dev does not publish; these never add Provider Model identities. */
export const MANUAL_OVERLAYS: Readonly<Record<string, ModelMetadataEntry>> = {
	"anthropic/claude-opus-5.5": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-opus-4-5": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-opus-4-5-20251101": {
		promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-opus-4-7": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-sonnet-5": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-opus-4-8": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-fable-5": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-fable-5-1": {
		promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-opus-5": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-opus-4-6": { promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE },
	"anthropic/claude-sonnet-4-6": {
		promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-haiku-4-5": {
		promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-haiku-4-5-20251001": {
		promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-sonnet-4-5": {
		promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE,
	},
	"anthropic/claude-sonnet-4-5-20250929": {
		promptCache: ANTHROPIC_EXPLICIT_PROMPT_CACHE,
	},
	"google/gemini-3-pro-preview": {
		thinking: { levels: ["low", "high"] },
	},
	"google/gemini-3.8-flash": {
		promptCache: GOOGLE_CACHED_CONTENT_PROMPT_CACHE,
	},
	"openai/gpt-5.6": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-5.6-luna": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-5.6-sol": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-5.6-terra": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-sol": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6.1-sol": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-luna": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-terra": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-astra": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	// Keep the last published models.dev facts while the manifest still declares this model.
	"opencode-go/grok-4.6": {
		cost: { input: 2, output: 6, cacheRead: 0.5 },
		limits: { context: 500_000, output: 500_000 },
		thinking: { levels: ["low", "medium", "high", "xhigh"] },
		tiers: [
			{
				inputTokensAbove: 200_000,
				input: 4,
				output: 12,
				cacheRead: 1,
			},
			{
				inputTokensAbove: 200_000,
				input: 4,
				output: 12,
				cacheRead: 1,
			},
		],
	},
};

export type BuildInput = Readonly<{
	overlays: Readonly<Record<string, ModelMetadataEntry>>;
	payload: unknown;
	providerModels: readonly ProviderModel[];
}>;

export type BuildResult = Readonly<{
	entries: Readonly<Record<string, ModelMetadataEntry>>;
	providerModels: readonly ProviderModel[];
	coverage: Readonly<{
		absentUpstream: readonly string[];
		fromOverlay: readonly string[];
		fromSource: number;
		providerModelCount: number;
		uncovered: readonly string[];
	}>;
}>;

/** Enriches only manifest-declared Provider Models; metadata never adds identity. */
export const buildProviderModelsWithMetadata = (
	input: BuildInput
): BuildResult => {
	const blocks = modelsDevBlocksFromPayload(input.payload);
	const entries: Record<string, ModelMetadataEntry> = {};
	const absentUpstream: string[] = [];
	const uncovered: string[] = [];
	const fromOverlay: string[] = [];
	let fromSource = 0;

	const providerModels = input.providerModels.map((model) => {
		const key = `${model.providerId}/${model.modelId}`;
		const upstream = blocks.get(model.providerId)?.get(model.modelId);
		const overlay = input.overlays[key];
		const sourceMetadata = upstream
			? metadataForModel(upstream, model)
			: undefined;
		const upstreamMetadata =
			sourceMetadata && Object.keys(sourceMetadata).length > 0
				? sourceMetadata
				: undefined;
		if (upstreamMetadata) {
			fromSource += 1;
		} else {
			absentUpstream.push(key);
			if (!overlay) {
				uncovered.push(key);
			}
		}
		if (overlay) {
			fromOverlay.push(key);
		}
		const metadata = { ...upstreamMetadata, ...overlay };
		entries[key] = metadata;
		return withProviderModelMetadata(model, metadata);
	});

	return {
		entries,
		providerModels,
		coverage: {
			absentUpstream,
			fromOverlay,
			fromSource,
			providerModelCount: input.providerModels.length,
			uncovered,
		},
	};
};
