// Runtime shape of the generated model metadata. The generated module
// (`./generated/model-metadata.generated.ts`) imports these types; the
// generator in `../scripts/metadata-model.ts` imports them too, so mapping and
// shape cannot drift apart.

import { z } from "zod";

/** Stable Effort identifiers Wincode can persist and send. */
export const effortIds = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type Effort = (typeof effortIds)[number];

/** Non-effort reasoning controls; availability is declared per model. */
export const reasoningModeIds = ["none", "thinking"] as const;
export type ReasoningMode = (typeof reasoningModeIds)[number];

export const effortSchema = z.enum(effortIds);
export const reasoningModeSchema = z.enum(reasoningModeIds);

export type ReasoningSelection = Readonly<
	| { effort: Effort; reasoningMode?: never }
	| { effort?: never; reasoningMode: ReasoningMode }
	| { effort?: never; reasoningMode?: never }
>;

/**
 * How a model expresses reasoning, normalized from models.dev
 * `reasoning_options[]`. The source may publish an Effort ladder, a toggle, and
 * budget bounds independently. A toggle supplies Modes; Efforts remain named
 * ladder entries, and budget-only models keep their derived automatic budget.
 */
export type ModelThinkingPolicy = Readonly<{
	/** The model exposes an on/off switch that can provide Reasoning Modes. */
	toggle?: true;
	/** The named Effort ladder published by the model's source. */
	levels?: readonly Effort[];
	/** Reasoning budget bounds (`budget_tokens.min` / `.max`). */
	budgetMin?: number;
	budgetMax?: number;
	/**
	 * The model has a budget but no Effort ladder or toggle. Its budget is
	 * derived automatically and offers no selectable reasoning choice.
	 */
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

/**
 * Metadata a Model Catalog entry does not carry inline. Every field is
 * optional because the sources are: a fact the upstream does not publish is
 * absent rather than defaulted.
 */
export type ModelMetadataEntry = Readonly<{
	cost?: ModelCost;
	limits?: ModelLimits;
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

const modelThinkingPolicySchema = z
	.object({
		budgetMax: z.number().int().nonnegative().optional(),
		budgetMin: z.number().int().nonnegative().optional(),
		levels: z.array(effortSchema).optional(),
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
