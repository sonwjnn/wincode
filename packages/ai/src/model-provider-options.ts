import { z } from "zod";
import { modelVariantsByProviderModel } from "./generated/model-variants.generated";
import {
	type ConnectionProviderId,
	type ModelVariant,
	normalizeModelVariantForModel,
	type SupportedChatModel,
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
						thinkingBudget: z.number().int().positive().optional(),
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

const MAX_OUTPUT_TOKENS = 32_000;
const reasoningSummaryModels: Readonly<Record<string, true>> = {
	"gpt-5.4-mini": true,
	"gpt-5.5": true,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
	"gpt-5.6-luna": true,
};
const anthropicAdaptiveModels: Readonly<Record<string, true>> = {
	"claude-opus-4-7": true,
	"claude-sonnet-5": true,
	"claude-opus-4-8": true,
	"claude-fable-5": true,
	"claude-opus-4-6": true,
	"claude-sonnet-4-6": true,
};
const anthropicManualModels: Readonly<Record<string, true>> = {
	"claude-opus-4-5": true,
	"claude-opus-4-5-20251101": true,
};
// TODO: Reconcile these manual reasoning-budget tables with the deleted
// `scripts/sync-model-pricing.ts` pipeline. Verify whether local model pricing
// should consume generated models.dev metadata before changing these values.
const anthropicBudgets: Readonly<Record<string, readonly [number, number]>> = {
	"claude-haiku-4-5": [16_000, 31_999],
	"claude-haiku-4-5-20251001": [16_000, 31_999],
	"claude-sonnet-4-5": [16_000, 31_999],
	"claude-sonnet-4-5-20250929": [16_000, 31_999],
};
const googleLevelModels: Readonly<Record<string, true>> = {
	"gemini-3.1-flash-lite": true,
	"gemini-3.5-flash": true,
	"gemini-3-flash-preview": true,
	"gemini-3.1-pro-preview": true,
	"gemini-3-pro-preview": true,
	"gemini-flash-latest": true,
	"gemini-flash-lite-latest": true,
	"gemma-4-31b-it": true,
};
const googleBudgets: Readonly<Record<string, readonly [number, number]>> = {
	"gemini-2.5-pro": [16_000, 31_999],
	"gemini-2.5-flash": [12_288, 24_576],
	"gemini-2.5-flash-lite": [12_288, 24_576],
};

const isListedModel = (
	models: Readonly<Record<string, true>>,
	modelId: string
): boolean => models[modelId] === true;

const generatedEntry = (
	model: Extract<SupportedChatModel, { provider: "opencode-go" }>
) => modelVariantsByProviderModel[`opencode-go/${model.id}`];

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

const toOpenAIReasoningEffort = (
	model: SupportedChatModel,
	variant: ModelVariant
): OpenAIReasoningEffort => {
	if (variant === "thinking") {
		throw unsupportedVariant(model, variant);
	}
	return variant;
};

const toAnthropicEffort = (
	model: SupportedChatModel,
	variant: ModelVariant
): AnthropicEffort => {
	if (variant === "none" || variant === "thinking" || variant === "minimal") {
		throw unsupportedVariant(model, variant);
	}
	return variant;
};

const toGoogleThinkingLevel = (
	model: SupportedChatModel,
	variant: ModelVariant
): GoogleThinkingLevel => {
	if (
		variant === "none" ||
		variant === "thinking" ||
		variant === "xhigh" ||
		variant === "max"
	) {
		throw unsupportedVariant(model, variant);
	}
	return variant;
};

const cappedOutputTokens = (maxOutputTokens: number | undefined): number =>
	Math.min(maxOutputTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);

const resolveOpenAIOptions = (
	model: Extract<SupportedChatModel, { provider: "openai" }>,
	variant: ModelVariant | undefined
): OpenAIProviderOptions => ({
	openai: {
		store: false,
		...(isListedModel(reasoningSummaryModels, model.id)
			? { reasoningSummary: "detailed" as const }
			: {}),
		...(variant === undefined
			? {}
			: { reasoningEffort: toOpenAIReasoningEffort(model, variant) }),
	},
});

const resolveAnthropicOptions = (
	model: Extract<SupportedChatModel, { provider: "anthropic" }>,
	variant: ModelVariant | undefined,
	maxOutputTokens: number | undefined
): ResolvedModelProviderOptions => {
	if (variant === undefined) {
		return {};
	}
	const effort = toAnthropicEffort(model, variant);
	if (isListedModel(anthropicAdaptiveModels, model.id)) {
		return {
			providerOptions: {
				anthropic: { effort, thinking: { type: "adaptive" } },
			},
		};
	}
	const isManual = isListedModel(anthropicManualModels, model.id);
	const selectedBudget = isManual
		? 16_000
		: anthropicBudgets[model.id]?.[effort === "high" ? 0 : 1];
	if (selectedBudget === undefined) {
		throw unsupportedVariant(model, variant);
	}
	const outputTokens = cappedOutputTokens(maxOutputTokens);
	if (selectedBudget >= outputTokens) {
		throw new Error(
			`Invalid Anthropic budget for ${model.id}: ${selectedBudget} must be less than ${outputTokens}`
		);
	}
	return {
		maxOutputTokens: outputTokens,
		providerOptions: {
			anthropic: {
				...(isManual ? { effort } : {}),
				thinking: { budgetTokens: selectedBudget, type: "enabled" },
			},
		},
	};
};

const resolveGoogleOptions = (
	model: Extract<SupportedChatModel, { provider: "google" }>,
	variant: ModelVariant | undefined,
	maxOutputTokens: number | undefined
): ResolvedModelProviderOptions => {
	if (variant === undefined) {
		return {};
	}
	if (isListedModel(googleLevelModels, model.id)) {
		return {
			maxOutputTokens: cappedOutputTokens(maxOutputTokens),
			providerOptions: {
				google: {
					thinkingConfig: {
						thinkingLevel: toGoogleThinkingLevel(model, variant),
					},
				},
			},
		};
	}
	const budget = googleBudgets[model.id];
	if (!budget || (variant !== "high" && variant !== "max")) {
		throw unsupportedVariant(model, variant);
	}
	const outputTokens = cappedOutputTokens(maxOutputTokens);
	const selectedBudget = budget[variant === "high" ? 0 : 1];
	if (selectedBudget >= outputTokens) {
		throw new Error(
			`Invalid Google budget for ${model.id}: ${selectedBudget} must be less than ${outputTokens}`
		);
	}
	return {
		maxOutputTokens: outputTokens,
		providerOptions: {
			google: { thinkingConfig: { thinkingBudget: selectedBudget } },
		},
	};
};

const withMaxOutputTokens = (
	maxOutputTokens: number | undefined
): Pick<ResolvedModelProviderOptions, "maxOutputTokens"> =>
	maxOutputTokens === undefined ? {} : { maxOutputTokens };

const resolveOpenCodeGoOpenAIOptions = (
	model: Extract<SupportedChatModel, { provider: "opencode-go" }>,
	variant: ModelVariant | undefined
): OpenAIProviderOptions => ({
	openai: {
		store: false,
		...(isListedModel(reasoningSummaryModels, model.id)
			? { reasoningSummary: "detailed" as const }
			: {}),
		...(variant === undefined
			? {}
			: { reasoningEffort: toOpenAIReasoningEffort(model, variant) }),
	},
});

const resolveOpenCodeGoAnthropicOptions = (
	entry: ReturnType<typeof generatedEntry>,
	variant: ModelVariant | undefined
): AnthropicProviderOptions | undefined => {
	if (entry?.kind === "toggle") {
		if (variant === "none") {
			return { anthropic: { thinking: { type: "disabled" } } };
		}
		if (variant === "thinking") {
			return { anthropic: { thinking: { type: "adaptive" } } };
		}
		return;
	}
	if (!entry?.budget || (variant !== "high" && variant !== "max")) {
		return;
	}
	return {
		anthropic: {
			thinking: {
				budgetTokens: variant === "high" ? entry.budget.high : entry.budget.max,
				type: "enabled",
			},
		},
	};
};

const resolveOpenCodeGoOptions = (
	model: Extract<SupportedChatModel, { provider: "opencode-go" }>,
	variant: ModelVariant | undefined,
	maxOutputTokens: number | undefined
): ResolvedModelProviderOptions => {
	const max = withMaxOutputTokens(maxOutputTokens);
	switch (model.sdk) {
		case "openai":
			return {
				...max,
				providerOptions: resolveOpenCodeGoOpenAIOptions(model, variant),
			};
		case "anthropic": {
			const providerOptions = resolveOpenCodeGoAnthropicOptions(
				generatedEntry(model),
				variant
			);
			return providerOptions ? { ...max, providerOptions } : max;
		}
		case "openai-compatible":
			return max;
		default:
			throw new Error("Unsupported OpenCode Go SDK");
	}
};

export const resolveModelProviderOptions = (
	model: SupportedChatModel,
	options: ModelProviderResolutionOptions = {}
): ResolvedModelProviderOptions => {
	const variant = normalizeVariantOrThrow(model, options.variant);
	switch (model.provider) {
		case "openai":
			return { providerOptions: resolveOpenAIOptions(model, variant) };
		case "anthropic":
			return resolveAnthropicOptions(model, variant, options.maxOutputTokens);
		case "google":
			return resolveGoogleOptions(model, variant, options.maxOutputTokens);
		case "opencode-go":
			return resolveOpenCodeGoOptions(model, variant, options.maxOutputTokens);
		default:
			throw new Error("Unsupported model provider");
	}
};
