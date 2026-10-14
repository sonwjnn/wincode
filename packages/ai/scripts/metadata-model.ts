// Assembles the generated model metadata module from the shared models.dev
// converter plus the manual overlays. Fetching lives in
// `sync-model-metadata.ts`; interpretation lives in `../src/models-dev.ts`.

import type {
	ModelMetadataEntry,
	ModelPromptCacheProtocolCapabilities,
	ModelThinkingPolicy,
	OpenAIPromptCacheProtocol,
	SupportedPromptCacheRetentionTier,
} from "../src/model-metadata";
import { metadataForModel } from "../src/models-dev";
import { modelsDevBlocksFromPayload } from "../src/models-dev-payload";
import { withProviderModelMetadata } from "../src/provider-model-metadata";
import type { ChatReasoningEffort, ProviderModel } from "../src/sdk";

type CatalogEntry = {
	readonly connectionProviderId: string;
	readonly displayName?: string;
	readonly id: string;
	readonly lifecycle: "active" | "retired";
	readonly protocol?: string;
	readonly provider: string;
};

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

/**
 * Facts models.dev does not publish. Every key here is a gap that must stay
 * visible rather than being silently defaulted.
 */
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
	"openai/gpt-5.6": {
		promptCache: OPENAI_RESPONSES_PROMPT_CACHE,
		reasoningSummary: true,
	},
	"openai/gpt-5.6-luna": {
		promptCache: OPENAI_RESPONSES_PROMPT_CACHE,
		reasoningSummary: true,
	},
	"openai/gpt-5.6-sol": {
		promptCache: OPENAI_RESPONSES_PROMPT_CACHE,
		reasoningSummary: true,
	},
	"openai/gpt-5.6-terra": {
		promptCache: OPENAI_RESPONSES_PROMPT_CACHE,
		reasoningSummary: true,
	},
	"openai/gpt-6-sol": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6.1-sol": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-luna": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-terra": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"openai/gpt-6-astra": { promptCache: OPENAI_RESPONSES_PROMPT_CACHE },
	"opencode-go/gpt-5.6-luna": { reasoningSummary: true },
};

export type BuildInput = {
	readonly catalog: readonly CatalogEntry[];
	readonly generatedAt: string;
	readonly overlays: Readonly<Record<string, ModelMetadataEntry>>;
	readonly payload: unknown;
	readonly source: string;
};

type OpenAIPromptCacheEntries = Readonly<
	Record<
		string,
		Readonly<
			Partial<
				Record<OpenAIPromptCacheProtocol, ModelPromptCacheProtocolCapabilities>
			>
		>
	>
>;

type ProviderModelMetadataEntries = Readonly<
	Record<string, ModelMetadataEntry>
>;
type OpenAIProviderModelMetadata = Readonly<{
	limits?: ProviderModel["limits"];
	pricing?: ProviderModel["pricing"];
	promptCacheRetentionTiers?: readonly SupportedPromptCacheRetentionTier[];
	promptCacheRetentionTtlMs?: ProviderModel["promptCacheRetentionTtlMs"];
	reasoningEfforts?: readonly ChatReasoningEffort[];
}>;
type OpenAIProviderModelMetadataEntries = Readonly<
	Record<string, OpenAIProviderModelMetadata>
>;
type SdkProviderModels = readonly Readonly<{
	modelId: string;
	protocolId: string;
	providerId: string;
}>[];

const providerModelMetadataEntriesFor = (
	rows: Readonly<Record<string, ModelMetadataEntry>>,
	providerId: string
): ProviderModelMetadataEntries => {
	const entries: Record<string, ModelMetadataEntry> = {};
	for (const key of Object.keys(rows).sort()) {
		if (key.startsWith(`${providerId}/`)) {
			entries[key.slice(providerId.length + 1)] = rows[key] ?? {};
		}
	}
	return entries;
};

const providerModelMetadataContentsFor = (
	entries: ProviderModelMetadataEntries,
	providerId: "anthropic" | "google" | "opencode-go",
	generatedAt: string,
	source: string
): string => {
	const body = JSON.stringify(entries, null, "\t");
	const exportName = providerId === "opencode-go" ? "openCodeGo" : providerId;
	const providerName = {
		anthropic: "Anthropic",
		google: "Google",
		"opencode-go": "OpenCode Go",
	}[providerId];
	return [
		"// Generated by packages/ai/scripts/sync-model-metadata.ts — do not edit.",
		`// Snapshot date: ${generatedAt}. Source: ${source}.`,
		`// ${providerName}-only model metadata; other provider entries are excluded.`,
		"",
		'import type { ModelMetadataEntry } from "../model-metadata";',
		"",
		`export const ${exportName}ModelMetadataById: Readonly<`,
		"\tRecord<string, ModelMetadataEntry>",
		`> = ${body};`,
		"",
	].join("\n");
};

const sdkProtocolIdFor = (
	entry: CatalogEntry,
	providerId: "google" | "opencode-go"
): string => {
	if (providerId === "google") {
		return "google";
	}
	if (entry.protocol === "openai") {
		return "openai-responses";
	}
	if (entry.protocol === "anthropic") {
		return "anthropic";
	}
	return "openai-compatible";
};

const sdkProviderModelsFor = (
	catalog: readonly CatalogEntry[],
	providerId: "google" | "opencode-go"
): SdkProviderModels =>
	catalog
		.filter(
			(entry) =>
				entry.connectionProviderId === providerId &&
				entry.lifecycle === "active"
		)
		.map((entry) => ({
			modelId: entry.id,
			protocolId: sdkProtocolIdFor(entry, providerId),
			providerId,
		}));

const sdkProviderModelsContentsFor = (
	models: SdkProviderModels,
	providerId: "google" | "opencode-go"
): string => {
	const name =
		providerId === "google" ? "googleSdkModels" : "openCodeGoSdkModels";
	const providerName = providerId === "google" ? "Google" : "OpenCode Go";
	return [
		"// Generated by packages/ai/scripts/sync-model-metadata.ts — do not edit.",
		`// ${providerName}-only active SDK models from the canonical catalog.`,
		"",
		'import type { ProviderModel } from "../sdk";',
		"",
		`export const ${name}: readonly ProviderModel[] = ${JSON.stringify(models, null, "\t")};`,
		"",
	].join("\n");
};

export type BuildResult = {
	/** The in-memory entries that the generated module will export. */
	readonly entries: Readonly<Record<string, ModelMetadataEntry>>;
	readonly anthropicModelMetadataContents: string;
	readonly anthropicModelMetadataEntries: ProviderModelMetadataEntries;
	readonly googleModelMetadataContents: string;
	readonly googleModelMetadataEntries: ProviderModelMetadataEntries;
	readonly openCodeGoModelMetadataContents: string;
	readonly openCodeGoModelMetadataEntries: ProviderModelMetadataEntries;
	readonly googleSdkModelsContents: string;
	readonly googleSdkModels: SdkProviderModels;
	readonly openCodeGoSdkModelsContents: string;
	readonly openCodeGoSdkModels: SdkProviderModels;
	readonly openAIPromptCacheContents: string;
	readonly openAIPromptCacheEntries: OpenAIPromptCacheEntries;
	readonly openAIProviderModelMetadataContents: string;
	readonly openAIProviderModelMetadataEntries: OpenAIProviderModelMetadataEntries;
	readonly contents: string;
	readonly coverage: {
		readonly activeEntries: number;
		readonly absentUpstream: readonly string[];
		readonly fromOverlay: readonly string[];
		readonly fromSource: number;
		readonly retiredEntries: number;
		/** Absent upstream with no overlay either: the entries with nothing. */
		readonly uncovered: readonly string[];
	};
};

const openAIPromptCacheEntriesFor = (
	rows: Readonly<Record<string, ModelMetadataEntry>>
): OpenAIPromptCacheEntries => {
	const entries: Record<
		string,
		NonNullable<NonNullable<ModelMetadataEntry["promptCache"]>["protocols"]>
	> = {};
	for (const key of Object.keys(rows).sort()) {
		if (!key.startsWith("openai/")) {
			continue;
		}
		const protocols = rows[key]?.promptCache?.protocols;
		if (protocols) {
			entries[key.slice("openai/".length)] = protocols;
		}
	}
	return entries;
};

const openAIPromptCacheContentsFor = (
	entries: OpenAIPromptCacheEntries,
	generatedAt: string,
	source: string
): string => {
	const body = JSON.stringify(entries, null, "\t");
	return [
		"// Generated by packages/ai/scripts/sync-model-metadata.ts — do not edit.",
		`// Snapshot date: ${generatedAt}. Source: ${source}.`,
		"// OpenAI-only protocol cache controls; other provider metadata is excluded.",
		"",
		'import type { ModelPromptCacheProtocolCapabilities, OpenAIPromptCacheProtocol } from "../model-metadata";',
		"",
		"export const openAIPromptCacheByModelId: Readonly<",
		"\tRecord<",
		"\t\tstring,",
		"\t\tReadonly<",
		"\t\t\tPartial<",
		"\t\t\t\tRecord<",
		"\t\t\t\t\tOpenAIPromptCacheProtocol,",
		"\t\t\t\t\tModelPromptCacheProtocolCapabilities",
		"\t\t\t\t>",
		"\t\t\t>",
		"\t\t>",
		"\t>",
		"> =",
		`${body};`,
		"",
	].join("\n");
};

const openAIThinkingPolicyFor = (
	policy: ModelMetadataEntry["thinking"]
): ModelThinkingPolicy | undefined =>
	policy === undefined
		? undefined
		: {
				...(policy.toggle === true ? { toggle: true as const } : {}),
				...(policy.levels === undefined ? {} : { levels: policy.levels }),
				...(policy.levelMap === undefined ? {} : { levelMap: policy.levelMap }),
			};

const openAIProviderModelMetadataFor = (
	modelId: string,
	metadata: ModelMetadataEntry
): OpenAIProviderModelMetadata => {
	const model: ProviderModel = {
		modelId,
		protocolId: "openai-responses",
		providerId: "openai",
	};
	const thinking = openAIThinkingPolicyFor(metadata.thinking);
	const normalized = withProviderModelMetadata(model, {
		...(metadata.cost === undefined ? {} : { cost: metadata.cost }),
		...(metadata.limits === undefined ? {} : { limits: metadata.limits }),
		...(metadata.tiers === undefined ? {} : { tiers: metadata.tiers }),
		...(metadata.promptCache === undefined
			? {}
			: { promptCache: metadata.promptCache }),
		...(thinking === undefined ? {} : { thinking }),
	});
	return {
		...(normalized.limits === undefined ? {} : { limits: normalized.limits }),
		...(normalized.pricing === undefined
			? {}
			: { pricing: normalized.pricing }),
		...(normalized.promptCacheRetentionTiers === undefined
			? {}
			: { promptCacheRetentionTiers: normalized.promptCacheRetentionTiers }),
		...(normalized.promptCacheRetentionTtlMs === undefined
			? {}
			: { promptCacheRetentionTtlMs: normalized.promptCacheRetentionTtlMs }),
		...(normalized.reasoningEfforts === undefined
			? {}
			: { reasoningEfforts: normalized.reasoningEfforts }),
	};
};

const openAIProviderModelMetadataEntriesFor = (
	rows: Readonly<Record<string, ModelMetadataEntry>>
): OpenAIProviderModelMetadataEntries => {
	const entries: Record<string, OpenAIProviderModelMetadata> = {};
	for (const [key, metadata] of Object.entries(rows).toSorted(
		([left], [right]) => left.localeCompare(right)
	)) {
		if (!key.startsWith("openai/")) {
			continue;
		}
		const modelId = key.slice("openai/".length);
		const modelMetadata = openAIProviderModelMetadataFor(modelId, metadata);
		if (
			modelMetadata.limits === undefined &&
			modelMetadata.pricing === undefined &&
			modelMetadata.reasoningEfforts === undefined &&
			modelMetadata.promptCacheRetentionTiers === undefined &&
			modelMetadata.promptCacheRetentionTtlMs === undefined
		) {
			continue;
		}
		entries[modelId] = modelMetadata;
	}
	return entries;
};

const openAIProviderModelMetadataContentsFor = (
	entries: OpenAIProviderModelMetadataEntries,
	generatedAt: string,
	source: string
): string => {
	const body = JSON.stringify(entries, null, "\t");
	return [
		"// Generated by packages/ai/scripts/sync-model-metadata.ts — do not edit.",
		`// Snapshot date: ${generatedAt}. Source: ${source}.`,
		"// OpenAI-only exact limits, prices, reasoning, and cache choices; unknown values stay absent.",
		"",
		'import type { ProviderModel } from "../sdk";',
		'import type { SupportedPromptCacheRetentionTier } from "../model-metadata";',
		"",
		"export type OpenAIProviderModelMetadata = Readonly<{",
		'\tlimits?: ProviderModel["limits"];',
		'\tpricing?: ProviderModel["pricing"];',
		'\treasoningEfforts?: ProviderModel["reasoningEfforts"];',
		"\tpromptCacheRetentionTiers?: readonly SupportedPromptCacheRetentionTier[];",
		'\tpromptCacheRetentionTtlMs?: ProviderModel["promptCacheRetentionTtlMs"];',
		"}>;",
		"",
		"export const openAIProviderModelMetadataById: Readonly<",
		"\tRecord<string, OpenAIProviderModelMetadata>",
		`> = ${body};`,
		"",
	].join("\n");
};

export const buildOpenAIProviderModelMetadataFile = (
	rows: Readonly<Record<string, ModelMetadataEntry>>,
	generatedAt: string,
	source: string
): Readonly<{
	contents: string;
	entries: OpenAIProviderModelMetadataEntries;
}> => {
	const entries = openAIProviderModelMetadataEntriesFor(rows);
	return {
		contents: openAIProviderModelMetadataContentsFor(
			entries,
			generatedAt,
			source
		),
		entries,
	};
};

/**
 * Builds the generated metadata module plus a coverage summary. Active catalog
 * entries with no upstream model are reported; retired entries retain any
 * available source or overlay metadata so persisted reasoning choices survive.
 */
export const buildModelMetadataFile = (input: BuildInput): BuildResult => {
	const blocks = modelsDevBlocksFromPayload(input.payload);
	const rows: Record<string, ModelMetadataEntry> = {};
	const absentUpstream: string[] = [];
	const uncovered: string[] = [];
	const fromOverlay: string[] = [];
	let activeEntries = 0;
	let fromSource = 0;
	let retiredEntries = 0;

	for (const entry of input.catalog) {
		const key = `${entry.connectionProviderId}/${entry.id}`;
		const upstream = blocks.get(entry.provider)?.get(entry.id);
		const overlay = input.overlays[key];
		const sourceMetadata = upstream
			? metadataForModel(upstream, {
					modelId: entry.id,
					providerId: entry.provider,
				})
			: undefined;
		const upstreamMetadata =
			sourceMetadata && Object.keys(sourceMetadata).length > 0
				? sourceMetadata
				: undefined;
		if (entry.lifecycle !== "active") {
			rows[key] = { ...upstreamMetadata, ...overlay };
			retiredEntries += 1;
			continue;
		}
		activeEntries += 1;
		if (upstreamMetadata) {
			fromSource += 1;
		} else {
			absentUpstream.push(key);
			// An overlay covering the gap is not the same as nothing covering
			// it, and only the latter is a problem worth naming in the header.
			if (!overlay) {
				uncovered.push(key);
			}
		}
		if (overlay) {
			fromOverlay.push(key);
		}
		rows[key] = { ...upstreamMetadata, ...overlay };
	}

	const header = [
		"// Generated by packages/ai/scripts/sync-model-metadata.ts — do not edit.",
		`// Snapshot date: ${input.generatedAt}. Source: ${input.source}.`,
		`// Catalog: ${activeEntries} active entries (${retiredEntries} retired), ${fromSource} from the source above.`,
		`// Upstream-missing entries (including overlay-covered): ${absentUpstream.join(", ") || "none"}.`,
		"//",
		"// Manual overlays supply facts the source does not publish:",
		`// ${fromOverlay.join(", ") || "none"}.`,
		"// Absent upstream, with no overlay either (reported, never fabricated):",
		`// ${uncovered.join(", ") || "none"}.`,
		`// Absent upstream but overlayed: ${absentUpstream.length - uncovered.length}.`,
		"",
	].join("\n");
	const body = JSON.stringify(rows, null, "\t");
	const contents = `${header}// The build-time age of this data, so a reader can tell how current it is.\nexport const modelMetadataSnapshotDate = ${JSON.stringify(input.generatedAt)};\n\nimport type { ModelMetadataEntry } from "../model-metadata";\n\nexport const modelMetadataByKey: Readonly<\n\tRecord<string, ModelMetadataEntry>\n> = ${body};\n`;
	const anthropicModelMetadataEntries = providerModelMetadataEntriesFor(
		rows,
		"anthropic"
	);
	const anthropicModelMetadataContents = providerModelMetadataContentsFor(
		anthropicModelMetadataEntries,
		"anthropic",
		input.generatedAt,
		input.source
	);
	const googleModelMetadataEntries = providerModelMetadataEntriesFor(
		rows,
		"google"
	);
	const googleModelMetadataContents = providerModelMetadataContentsFor(
		googleModelMetadataEntries,
		"google",
		input.generatedAt,
		input.source
	);
	const openCodeGoModelMetadataEntries = providerModelMetadataEntriesFor(
		rows,
		"opencode-go"
	);
	const openCodeGoModelMetadataContents = providerModelMetadataContentsFor(
		openCodeGoModelMetadataEntries,
		"opencode-go",
		input.generatedAt,
		input.source
	);
	const googleSdkModels = sdkProviderModelsFor(input.catalog, "google");
	const googleSdkModelsContents = sdkProviderModelsContentsFor(
		googleSdkModels,
		"google"
	);
	const openCodeGoSdkModels = sdkProviderModelsFor(
		input.catalog,
		"opencode-go"
	);
	const openCodeGoSdkModelsContents = sdkProviderModelsContentsFor(
		openCodeGoSdkModels,
		"opencode-go"
	);
	const openAIPromptCacheEntries = openAIPromptCacheEntriesFor(rows);
	const openAIPromptCacheContents = openAIPromptCacheContentsFor(
		openAIPromptCacheEntries,
		input.generatedAt,
		input.source
	);
	const openAIProviderModelMetadata = buildOpenAIProviderModelMetadataFile(
		rows,
		input.generatedAt,
		input.source
	);

	return {
		anthropicModelMetadataContents,
		anthropicModelMetadataEntries,
		contents,
		entries: rows,
		googleModelMetadataContents,
		googleModelMetadataEntries,
		googleSdkModelsContents,
		googleSdkModels,
		openCodeGoModelMetadataContents,
		openCodeGoModelMetadataEntries,
		openCodeGoSdkModelsContents,
		openCodeGoSdkModels,
		openAIPromptCacheContents,
		openAIPromptCacheEntries,
		openAIProviderModelMetadataContents: openAIProviderModelMetadata.contents,
		openAIProviderModelMetadataEntries: openAIProviderModelMetadata.entries,
		coverage: {
			absentUpstream,
			activeEntries,
			fromOverlay,
			fromSource,
			retiredEntries,
			uncovered,
		},
	};
};
