// Runtime shape of supplemental facts merged into manifest-declared Provider
// Models by the build-time catalog generator. The generator and its runtime
// validation share these types so metadata mapping and shape cannot drift.

import { z } from "zod";
import {
	type ThinkingLevel,
	type ThinkingLevelMap,
	thinkingLevelSchema,
} from "./thinking-level.ts";

export type {
	ThinkingLevel,
	ThinkingLevelMap,
	ThinkingSelection,
} from "./thinking-level.ts";
export { thinkingLevelIds, thinkingLevelSchema } from "./thinking-level.ts";

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

export const supportedPromptCacheRetentionTierIds = ["short", "long"] as const;
export const promptCacheRetentionTierIds = [
	...supportedPromptCacheRetentionTierIds,
	"off",
] as const;
export type SupportedPromptCacheRetentionTier =
	(typeof supportedPromptCacheRetentionTierIds)[number];
export type PromptCacheRetentionTier =
	(typeof promptCacheRetentionTierIds)[number];
export const supportedPromptCacheRetentionTierSchema = z.enum(
	supportedPromptCacheRetentionTierIds
);
export const promptCacheRetentionTierSchema = z.enum(
	promptCacheRetentionTierIds
);

export { parsePromptCacheTtlMs } from "./prompt-cache-ttl.ts";

/** The explicit cache controls and retention tiers verified for one Model. */
export const openAIPromptCacheProtocolIds = [
	"openai-chat",
	"openai-responses",
] as const;
export type OpenAIPromptCacheProtocol =
	(typeof openAIPromptCacheProtocolIds)[number];
const openAIPromptCacheProtocolSchema = z.enum(openAIPromptCacheProtocolIds);

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
 * Supplemental facts used to enrich SDK-declared Provider Models. Every field
 * is optional because unpublished facts remain absent rather than defaulted.
 */
export type ModelMetadataEntry = Readonly<{
	cost?: ModelCost;
	limits?: ModelLimits;
	promptCache?: ModelPromptCacheCapabilities;
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

const thinkingLevelMapSchema = z.partialRecord(
	thinkingLevelSchema,
	z.string().nullable()
) satisfies z.ZodType<ThinkingLevelMap>;

const promptCacheRetentionValuesSchema = z
	.partialRecord(supportedPromptCacheRetentionTierSchema, z.string().min(1))
	.refine((values) => Object.keys(values).length > 0);

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
				values: promptCacheRetentionValuesSchema,
			})
			.strict()
			.optional(),
	})
	.strict() satisfies z.ZodType<ModelPromptCacheProtocolCapabilities>;

const modelPromptCacheCapabilitiesSchema = z
	.object({
		explicit: z
			.object({
				retentionTiers: z.array(supportedPromptCacheRetentionTierSchema).min(1),
			})
			.strict(),
		googleCachedContent: z
			.object({
				ttl: promptCacheRetentionValuesSchema,
			})
			.strict()
			.optional(),
		protocols: z
			.partialRecord(
				openAIPromptCacheProtocolSchema,
				modelPromptCacheProtocolCapabilitiesSchema
			)
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
		thinking: modelThinkingPolicySchema.optional(),
		tiers: z.array(modelCostTierSchema).optional(),
	})
	.strict() satisfies z.ZodType<ModelMetadataEntry>;
