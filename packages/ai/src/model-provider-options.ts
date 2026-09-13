import { z } from "zod";
import type { ModelMetadataEntry } from "./model-metadata";
import { getModelMetadata } from "./model-metadata-runtime";
import {
	type ConnectionProviderId,
	type ModelThinkingPolicy,
	type ModelVariant,
	normalizeModelVariantForModel,
	type SupportedChatModel,
	supportsReasoningVariants,
} from "./models";

export type OpenAIReasoningEffort = Exclude<ModelVariant, "thinking">;
export type AnthropicEffort = Exclude<
	ModelVariant,
	"none" | "thinking" | "minimal"
>;
export type GoogleThinkingLevel = Exclude<
	ModelVariant,
	"none" | "thinking" | "xhigh" | "max"
>;

export type OpenAIProviderOptions = {
	readonly openai: {
		readonly reasoningEffort?: OpenAIReasoningEffort;
		readonly reasoningSummary?: "detailed";
		readonly store?: boolean;
	};
};

export type AnthropicThinking =
	| { readonly type: "adaptive" }
	| { readonly type: "disabled" }
	| { readonly budgetTokens: number; readonly type: "enabled" };

export type AnthropicProviderOptions = {
	readonly anthropic: {
		readonly effort?: AnthropicEffort;
		readonly thinking?: AnthropicThinking;
	};
};

export type GoogleProviderOptions = {
	readonly google: {
		readonly thinkingConfig: {
			readonly thinkingBudget?: number;
			readonly thinkingLevel?: GoogleThinkingLevel;
		};
	};
};

/**
 * Provider extensions are deliberately a discriminated union. A caller cannot
 * accidentally send Google options to OpenAI or erase provider capabilities
 * into a common bag of unknown values.
 */
export type ModelProviderOptions =
	| OpenAIProviderOptions
	| AnthropicProviderOptions
	| GoogleProviderOptions;

export type ProviderOptionsFor<P extends ConnectionProviderId> =
	P extends "openai"
		? OpenAIProviderOptions
		: P extends "anthropic"
			? AnthropicProviderOptions
			: P extends "google"
				? GoogleProviderOptions
				: OpenAIProviderOptions | AnthropicProviderOptions;

export type ModelProviderResolutionOptions = {
	readonly maxOutputTokens?: number;
	readonly variant?: ModelVariant;
};

export type ResolvedModelProviderOptions = {
	readonly maxOutputTokens?: number;
	readonly providerOptions?: ModelProviderOptions;
};

export const openAIProviderOptionsSchema = z
	.object({
		openai: z
			.object({
				reasoningEffort: z
					.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
					.optional(),
				reasoningSummary: z.literal("detailed").optional(),
				store: z.boolean().optional(),
			})
			.strict(),
	})
	.strict();

export const anthropicProviderOptionsSchema = z
	.object({
		anthropic: z
			.object({
				effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
				thinking: z
					.discriminatedUnion("type", [
						z.object({ type: z.literal("adaptive") }).strict(),
						z.object({ type: z.literal("disabled") }).strict(),
						z
							.object({
								budgetTokens: z.number().int().positive(),
								type: z.literal("enabled"),
							})
							.strict(),
					])
					.optional(),
			})
			.strict(),
	})
	.strict();

export const googleProviderOptionsSchema = z
	.object({
		google: z
			.object({
				thinkingConfig: z
					.object({
						// 0 is Google's explicit "thinking off", so zero is legal.
						thinkingBudget: z.number().int().nonnegative().optional(),
						thinkingLevel: z
							.enum(["minimal", "low", "medium", "high"])
							.optional(),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();

export const modelProviderOptionsSchema = z.union([
	openAIProviderOptionsSchema,
	anthropicProviderOptionsSchema,
	googleProviderOptionsSchema,
]);

export const MODEL_OUTPUT_TOKEN_LIMIT = 32_000;

/**
 * Reasoning budget for a model whose source publishes budget bounds but no
 * level ladder (Anthropic 4.5, `gemini-2.5-pro`). A quarter of the model's own
 * output limit reproduces the previous fixed 16000 for a 64000-output model
 * instead of hard-coding it, and stays inside the published bounds.
 */
const REASONING_BUDGET_SHARE = 0.25;

const isListedModel = (
	models: Readonly<Record<string, true>>,
	modelId: string
): boolean => models[modelId] === true;

const unsupportedVariant = (
	model: SupportedChatModel,
	variant: string
): Error =>
	new Error(
		`Unsupported model variant: ${model.connectionProviderId}/${model.id}/${variant}`
	);

const normalizeVariantOrThrow = (
	model: SupportedChatModel,
	variant: string | undefined
): ModelVariant | undefined => {
	const normalized = normalizeModelVariantForModel(model, variant);
	if (variant !== undefined && normalized === undefined) {
		throw unsupportedVariant(model, variant);
	}
	return normalized;
};

/**
 * Providers whose thinking budget the provider chooses itself, so no budget
 * crosses the wire. Every other model with a level ladder and a budget bound
 * sends a named effort plus a derived budget.
 */
const providerChosenBudgetModels: Readonly<Record<string, true>> = {
	"claude-fable-5": true,
	"claude-fable-5-1": true,
	"claude-opus-4-6": true,
	"claude-opus-4-7": true,
	"claude-opus-4-8": true,
	"claude-opus-5": true,
	"claude-sonnet-4-6": true,
	"claude-sonnet-5": true,
};

/**
 * Bounded reasoning budget for a model that publishes budget bounds but no
 * usable ladder. The result never reaches the output limit — a budget equal to
 * the cap would leave no room for the answer — and never drops below a
 * published minimum. `null` means the output limit is too small to reason
 * inside at all, which the caller turns into "thinking disabled".
 */
const reasoningBudget = (
	policy: ModelThinkingPolicy,
	outputTokens: number
): number | null => {
	const floor = policy.budgetMin ?? 1;
	const ceiling = Math.min(
		outputTokens - 1,
		policy.budgetMax ?? MODEL_OUTPUT_TOKEN_LIMIT
	);
	return ceiling < floor
		? null
		: Math.max(
				floor,
				Math.min(Math.round(outputTokens * REASONING_BUDGET_SHARE), ceiling)
			);
};

/**
 * The output budget a request may use. The model's own limit is the frame a
 * reasoning budget is derived inside; the operational cap only lowers it, and
 * only when the caller asked for one.
 */
const effectiveOutputTokens = (
	metadata: ModelMetadataEntry | undefined,
	maxOutputTokens: number | undefined
): number =>
	Math.min(
		maxOutputTokens ?? metadata?.limits?.output ?? MODEL_OUTPUT_TOKEN_LIMIT,
		MODEL_OUTPUT_TOKEN_LIMIT
	);

const withDerivedReasoningOutputTokens = (
	max: Pick<ResolvedModelProviderOptions, "maxOutputTokens">,
	requestedOutputTokens: number | undefined,
	shouldDerive: boolean,
	outputTokens: number
): Pick<ResolvedModelProviderOptions, "maxOutputTokens"> => {
	if (requestedOutputTokens === undefined && shouldDerive) {
		return { maxOutputTokens: outputTokens };
	}
	return max;
};

/**
 * Anthropic thinking for one resolved level. Toggle-only models use adaptive
 * thinking; models that publish bounds get a bounded enabled budget. Named
 * levels still use the provider's own budget for the listed adaptive models.
 */
const anthropicThinking = (
	model: SupportedChatModel,
	policy: ModelThinkingPolicy,
	outputTokens: number,
	level: ModelVariant | undefined,
	disabled: boolean
): AnthropicThinking | undefined => {
	if (disabled) {
		return { type: "disabled" };
	}
	if (isListedModel(providerChosenBudgetModels, model.id)) {
		return { type: "adaptive" };
	}
	if (
		level === undefined &&
		policy.budgetMin === undefined &&
		policy.budgetMax === undefined
	) {
		return { type: "adaptive" };
	}
	const budget = reasoningBudget(policy, outputTokens);
	return budget === null
		? { type: "disabled" }
		: { budgetTokens: budget, type: "enabled" };
};

type ReasoningWiring = "anthropic" | "google" | "openai";
const unlevelledReasoning = (
	wiring: Exclude<ReasoningWiring, "openai">,
	policy: ModelThinkingPolicy,
	outputTokens: number
): ModelProviderOptions => {
	const budget = reasoningBudget(policy, outputTokens);
	if (wiring === "google") {
		return {
			google: {
				thinkingConfig:
					budget === null ? { thinkingBudget: 0 } : { thinkingBudget: budget },
			},
		};
	}
	return {
		anthropic: {
			thinking:
				budget === null
					? { type: "disabled" }
					: { budgetTokens: budget, type: "enabled" },
		},
	};
};

/**
 * Which provider's option shape reaches the wire for one catalog entry.
 * OpenCode Go serves different model families behind one connection, so its
 * entries route by SDK rather than by connection identity.
 */
const reasoningWiring = (model: SupportedChatModel): ReasoningWiring | null => {
	if (model.provider === "opencode-go") {
		return supportsReasoningVariants(model) ? model.sdk : null;
	}
	return model.provider;
};

const openAIReasoningEffort = (
	variant: ModelVariant
): OpenAIReasoningEffort | undefined => {
	if (variant === "none") {
		return "none";
	}
	if (variant === "thinking") {
		return;
	}
	return variant;
};
const googleThinkingLevel = (
	level: ModelVariant | undefined
): GoogleThinkingLevel | undefined => {
	switch (level) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return level;
		default:
			return;
	}
};

const anthropicEffort = (
	level: ModelVariant | undefined
): AnthropicEffort | undefined => {
	switch (level) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return level;
		default:
			return;
	}
};

const openAIProviderOptions = (
	metadata: ModelMetadataEntry | undefined,
	variant: ModelVariant | undefined
): OpenAIProviderOptions => {
	const reasoningEffort =
		variant === undefined ? undefined : openAIReasoningEffort(variant);
	return {
		openai: {
			store: false,
			...(metadata?.reasoningSummary
				? { reasoningSummary: "detailed" as const }
				: {}),
			...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		},
	};
};
const googleThinkingConfig = (
	model: SupportedChatModel,
	variant: ModelVariant,
	level: ModelVariant | undefined,
	disabled: boolean,
	policy: ModelThinkingPolicy,
	outputTokens: number
): GoogleProviderOptions["google"]["thinkingConfig"] => {
	const thinkingLevel = googleThinkingLevel(level);
	if (level !== undefined && thinkingLevel === undefined) {
		throw unsupportedVariant(model, variant);
	}
	if (thinkingLevel !== undefined) {
		return { thinkingLevel };
	}
	if (disabled) {
		return { thinkingBudget: 0 };
	}
	if (policy.budgetMin !== undefined || policy.budgetMax !== undefined) {
		const budget = reasoningBudget(policy, outputTokens);
		return budget === null ? { thinkingBudget: 0 } : { thinkingBudget: budget };
	}
	return {};
};

/**
 * Translation of a Thinking Level into provider options, driven entirely by
 * the entry's published policy. The five shapes models.dev publishes —
 * levels-only, toggle-only, toggle+levels, budget-only, and no policy at all —
 * all reduce to three questions: is reasoning off, which named effort, and
 * which budget.
 */
export const resolveReasoning = (
	model: SupportedChatModel,
	metadata: ModelMetadataEntry | undefined,
	variant: ModelVariant | undefined,
	maxOutputTokens: number | undefined
): ResolvedModelProviderOptions => {
	const wiring = reasoningWiring(model);
	const max = withMaxOutputTokens(maxOutputTokens);
	if (wiring === null) {
		return max;
	}
	const policy = metadata?.thinking;
	if (variant === undefined) {
		if (wiring === "openai") {
			return {
				...max,
				providerOptions: openAIProviderOptions(metadata, variant),
			};
		}
		if (!policy?.unlevelled) {
			return max;
		}
		const outputTokens = effectiveOutputTokens(metadata, maxOutputTokens);
		return {
			...withDerivedReasoningOutputTokens(
				max,
				maxOutputTokens,
				true,
				outputTokens
			),
			providerOptions: unlevelledReasoning(wiring, policy, outputTokens),
		};
	}
	if (!policy) {
		throw unsupportedVariant(model, variant);
	}
	const outputTokens = effectiveOutputTokens(metadata, maxOutputTokens);
	const level =
		variant === "none" || variant === "thinking" ? undefined : variant;
	const disabled = variant === "none";

	if (wiring === "openai") {
		return {
			...max,
			providerOptions: openAIProviderOptions(metadata, variant),
		};
	}

	if (wiring === "google") {
		// Exactly one of the three shapes applies: a named level, an explicit
		// off, or "on, provider's own budget".
		const thinkingConfig = googleThinkingConfig(
			model,
			variant,
			level,
			disabled,
			policy,
			outputTokens
		);
		const providerOptions: GoogleProviderOptions = {
			google: { thinkingConfig },
		};
		const hasBudget =
			"thinkingBudget" in thinkingConfig &&
			typeof thinkingConfig.thinkingBudget === "number" &&
			thinkingConfig.thinkingBudget > 0;
		return {
			...(disabled
				? max
				: withDerivedReasoningOutputTokens(
						max,
						maxOutputTokens,
						hasBudget,
						outputTokens
					)),
			providerOptions,
		};
	}

	const effort = anthropicEffort(level);
	if (level !== undefined && effort === undefined) {
		throw unsupportedVariant(model, variant);
	}
	const thinking = anthropicThinking(
		model,
		policy,
		outputTokens,
		level,
		disabled
	);
	const providerOptions: AnthropicProviderOptions = {
		anthropic: {
			...(effort === undefined ? {} : { effort }),
			...(thinking === undefined ? {} : { thinking }),
		},
	};
	return {
		...(disabled
			? max
			: withDerivedReasoningOutputTokens(
					max,
					maxOutputTokens,
					thinking?.type === "enabled",
					outputTokens
				)),
		providerOptions,
	};
};

const withMaxOutputTokens = (
	maxOutputTokens: number | undefined
): Pick<ResolvedModelProviderOptions, "maxOutputTokens"> =>
	maxOutputTokens === undefined ? {} : { maxOutputTokens };

/**
 * Whether a provider option bag actually says anything. A Google on/off switch
 * with no published budget has no explicit value to send; an empty bag would
 * only add noise to the request.
 */
const hasProviderOptions = (value: unknown): boolean => {
	if (value === undefined || value === null) {
		return false;
	}
	if (typeof value !== "object") {
		return true;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	return Object.values(value).some(hasProviderOptions);
};

export const resolveModelProviderOptions = (
	model: SupportedChatModel,
	options: ModelProviderResolutionOptions = {}
): ResolvedModelProviderOptions => {
	const variant = normalizeVariantOrThrow(model, options.variant);
	const wiring = reasoningWiring(model);
	if (wiring === null) {
		return withMaxOutputTokens(options.maxOutputTokens);
	}
	const metadata = getModelMetadata(model);
	const resolved = resolveReasoning(
		model,
		metadata,
		variant,
		options.maxOutputTokens
	);
	const providerOptions =
		resolved.providerOptions === undefined
			? undefined
			: Object.values(resolved.providerOptions)[0];
	return hasProviderOptions(providerOptions)
		? resolved
		: withMaxOutputTokens(options.maxOutputTokens);
};
