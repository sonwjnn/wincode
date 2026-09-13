// Runtime shape of the generated model metadata. The generated module
// (`./generated/model-metadata.generated.ts`) imports these types; the
// generator in `../scripts/metadata-model.ts` imports them too, so mapping and
// shape cannot drift apart.

import { z } from "zod";

/**
 * The closed set of reasoning-level identifiers Wincode can persist and send.
 * A Model Catalog entry supports a subset of these; `"thinking"` exists for
 * models that expose only an on/off switch. `models.ts` re-exports this as the
 * `ModelVariant` type, and the metadata generator filters upstream effort
 * values against it.
 */
export const modelVariantIds = [
	"none",
	"thinking",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ModelVariant = (typeof modelVariantIds)[number];

/**
 * How a model expresses reasoning, normalized from models.dev
 * `reasoning_options[]`. The two axes are independent, not alternatives:
 * `claude-sonnet-5` carries both `toggle` and `effort`, so a model can be
 * switchable *and* levelled, and its `"none"` level means the same thing as
 * the toggle's off state. Four Anthropic models carry budget bounds with no
 * level ladder at all.
 */
export type ModelThinkingPolicy = {
	/** The model exposes an on/off switch, i.e. `"none"` is a legal level. */
	readonly toggle?: true;
	/** The level ladder, when the source publishes one (`effort.values`). */
	readonly levels?: readonly ModelVariant[];
	/** Reasoning budget bounds (`budget_tokens.min` / `.max`). */
	readonly budgetMin?: number;
	readonly budgetMax?: number;
	/**
	 * The model is budget-bounded with no ladder and no switch, so there is
	 * nothing for a user to pick: it reasons within a derived budget. Such a
	 * model offers no selectable level at all.
	 */
	readonly unlevelled?: true;
};

/** A context-length threshold at which every rate changes together. */
export type ModelCostTier = {
	readonly inputTokensAbove: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
};

/** USD per 1M tokens. `input` is uncached input; an unpublished rate stays absent. */
export type ModelCost = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
};

export type ModelLimits = {
	readonly context: number;
	readonly output?: number;
};

/**
 * Metadata a Model Catalog entry does not carry inline. Every field is
 * optional because the sources are: a fact the upstream does not publish is
 * absent rather than defaulted.
 */
export type ModelMetadataEntry = {
	readonly cost?: ModelCost;
	readonly limits?: ModelLimits;
	readonly reasoningSummary?: true;
	readonly thinking?: ModelThinkingPolicy;
	readonly tiers?: readonly ModelCostTier[];
};

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

const modelThinkingPolicySchema = z
	.object({
		budgetMax: z.number().int().nonnegative().optional(),
		budgetMin: z.number().int().nonnegative().optional(),
		levels: z.array(z.enum(modelVariantIds)).optional(),
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
		reasoningSummary: z.literal(true).optional(),
		thinking: modelThinkingPolicySchema.optional(),
		tiers: z.array(modelCostTierSchema).optional(),
	})
	.strict() satisfies z.ZodType<ModelMetadataEntry>;
