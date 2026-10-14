// Runtime shape of the generated model metadata. The generated module
// (`./generated/model-metadata.generated.ts`) imports these types; the
// generator in `../scripts/metadata-model.ts` imports them too, so mapping and
// shape cannot drift apart.

import { z } from "zod";

/** Stable reasoning levels Wincode can persist and send. */
export const thinkingLevelIds = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ThinkingLevel = (typeof thinkingLevelIds)[number];
export type ThinkingLevelMap = Readonly<
	Partial<Record<ThinkingLevel, string | null>>
>;

export const thinkingLevelSchema = z.enum(thinkingLevelIds);

export type ThinkingSelection = Readonly<{
	thinkingLevel?: ThinkingLevel;
}>;

/**
 * How a model expresses reasoning, normalized from models.dev
 * `reasoning_options[]`. A per-model map carries selectable levels and their
 * provider-native values; budget-only models keep their derived automatic
 * budget without a selectable level.
 */
export type ModelThinkingPolicy = Readonly<{
	/** Per-model native level overrides; null means unsupported. */
	levelMap?: ThinkingLevelMap;
	/** Source-published thinking levels, used to derive the model's level map. */
	levels?: readonly ThinkingLevel[];
	/** The model exposes a binary thinking switch. */
	toggle?: true;
	/** Reasoning budget bounds (`budget_tokens.min` / `.max`). */
	budgetMin?: number;
	budgetMax?: number;
	/** The model's budget is derived automatically, with no selectable level. */
	unlevelled?: true;
}>;

/** A context-length threshold at which every rate changes together. */
export type ModelCostTier = Readonly<{
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}>;

/** USD per 1M tokens. `input` is uncached input; an unpublished rate stays absent. */
export type ModelCost = Readonly<{
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}>;

export type ModelLimits = Readonly<{
	context: number;
	output?: number;
}>;

export type PromptCacheRetentionTier = "short" | "long" | "off";
export type SupportedPromptCacheRetentionTier = Exclude<
	PromptCacheRetentionTier,
	"off"
>;

export { parsePromptCacheTtlMs } from "./prompt-cache-ttl.ts";

/** The explicit cache controls and retention tiers verified for one Model. */
export type OpenAIPromptCacheProtocol = "openai-chat" | "openai-responses";

export type ModelPromptCacheProtocolCapabilities = Readonly<{
	breakpoints?: true;
	eligibility: Readonly<{ minimumInputTokens: number }>;
	promptCacheKey?: true;
	retention?: Readonly<{
		field: "prompt_cache_options.ttl" | "prompt_cache_retention";
		values: Readonly<
			Partial<Record<SupportedPromptCacheRetentionTier, string>>
		>;
	}>;
}>;

export type ModelPromptCacheCapabilities = Readonly<{
	explicit: Readonly<{
		retentionTiers: readonly SupportedPromptCacheRetentionTier[];
	}>;
	googleCachedContent?: Readonly<{
		ttl: Readonly<Partial<Record<SupportedPromptCacheRetentionTier, string>>>;
	}>;
	protocols?: Readonly<
		Partial<
			Record<OpenAIPromptCacheProtocol, ModelPromptCacheProtocolCapabilities>
		>
	>;
}>;

/**
 * Metadata a Model Catalog entry does not carry inline. Every field is
 * optional because the sources are: a fact the upstream does not publish is
 * absent rather than defaulted.
 */
export type ModelMetadataEntry = Readonly<{
	cost?: ModelCost;
	limits?: ModelLimits;
	promptCache?: ModelPromptCacheCapabilities;
	reasoningSummary?: true;
	thinking?: ModelThinkingPolicy;
	tiers?: readonly ModelCostTier[];
}>;

const modelCostSchema = z
	.object({
		cacheRead: z.number().nonnegative().optional(),
		cacheWrite: z.number().nonnegative().optional(),
		input: z.number().nonnegative(),
		output: z.number().nonnegative(),
	})
	.strict() satisfies z.ZodType<ModelCost>;

const modelCostTierSchema = modelCostSchema
	.extend({ inputTokensAbove: z.number().int().positive() })
	.strict();

const thinkingLevelMapSchema = z
	.object({
		off: z.string().nullable().optional(),
		minimal: z.string().nullable().optional(),
		low: z.string().nullable().optional(),
		medium: z.string().nullable().optional(),
		high: z.string().nullable().optional(),
		xhigh: z.string().nullable().optional(),
		max: z.string().nullable().optional(),
	})
	.strict() satisfies z.ZodType<ThinkingLevelMap>;

const modelPromptCacheProtocolCapabilitiesSchema = z
	.object({
		breakpoints: z.literal(true).optional(),
		eligibility: z
			.object({ minimumInputTokens: z.number().int().positive() })
			.strict(),
		promptCacheKey: z.literal(true).optional(),
		retention: z
			.object({
				field: z.enum(["prompt_cache_options.ttl", "prompt_cache_retention"]),
				values: z
					.object({
						short: z.string().min(1).optional(),
						long: z.string().min(1).optional(),
					})
					.strict()
					.refine((values) => Object.keys(values).length > 0),
			})
			.strict()
			.optional(),
	})
	.strict() satisfies z.ZodType<ModelPromptCacheProtocolCapabilities>;

const modelPromptCacheCapabilitiesSchema = z
	.object({
		explicit: z
			.object({
				retentionTiers: z.array(z.enum(["short", "long"])).min(1),
			})
			.strict(),
		googleCachedContent: z
			.object({
				ttl: z
					.object({
						short: z.string().min(1).optional(),
						long: z.string().min(1).optional(),
					})
					.strict()
					.refine((values) => Object.keys(values).length > 0),
			})
			.strict()
			.optional(),
		protocols: z
			.object({
				"openai-chat": modelPromptCacheProtocolCapabilitiesSchema.optional(),
				"openai-responses":
					modelPromptCacheProtocolCapabilitiesSchema.optional(),
			})
			.strict()
			.optional(),
	})
	.strict() satisfies z.ZodType<ModelPromptCacheCapabilities>;

const modelThinkingPolicySchema = z
	.object({
		budgetMax: z.number().int().nonnegative().optional(),
		budgetMin: z.number().int().nonnegative().optional(),
		levelMap: thinkingLevelMapSchema.optional(),
		levels: z.array(thinkingLevelSchema).optional(),
		toggle: z.literal(true).optional(),
		unlevelled: z.literal(true).optional(),
	})
	.strict();

/**
 * Validates both the committed snapshot and a fetched runtime table. Kept here
 * beside the type so the two cannot drift; the generated module carries a
 * compile-time copy of the same shape.
 */
export const modelMetadataEntrySchema = z
	.object({
		cost: modelCostSchema.optional(),
		limits: z
			.object({
				context: z.number().int().positive(),
				output: z.number().int().positive().optional(),
			})
			.strict()
			.optional(),
		promptCache: modelPromptCacheCapabilitiesSchema.optional(),
		reasoningSummary: z.literal(true).optional(),
		thinking: modelThinkingPolicySchema.optional(),
		tiers: z.array(modelCostTierSchema).optional(),
	})
	.strict() satisfies z.ZodType<ModelMetadataEntry>;
