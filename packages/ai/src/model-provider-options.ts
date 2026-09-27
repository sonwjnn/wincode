import {
	isArray,
	isNull,
	isNumber,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import type { ReadonlyDeep } from "type-fest";
import { z } from "zod";
import type { ModelMetadataEntry } from "./model-metadata";
import { getModelMetadata } from "./model-metadata-runtime";
import {
	type ConnectionProviderId,
	createReasoningSelection,
	type Effort,
	type ModelThinkingPolicy,
	normalizeModelEffortForModel,
	normalizeReasoningModeForModel,
	type ReasoningMode,
	type ReasoningSelection,
	type SupportedChatModel,
	supportsSelectableReasoning,
} from "./models";

export type OpenAIReasoningEffort = Effort | "none";
export type AnthropicEffort = Exclude<Effort, "minimal">;
export type GoogleThinkingLevel = Exclude<Effort, "xhigh" | "max">;

export type OpenAIProviderOptions = ReadonlyDeep<{
	openai: {
		reasoningEffort?: OpenAIReasoningEffort;
		reasoningSummary?: "detailed";
		store?: boolean;
	};
}>;

export type AnthropicThinking = ReadonlyDeep<
	| { type: "adaptive" }
	| { type: "disabled" }
	| { budgetTokens: number; type: "enabled" }
>;

export type AnthropicProviderOptions = ReadonlyDeep<{
	anthropic: {
		effort?: AnthropicEffort;
		thinking?: AnthropicThinking;
	};
}>;

export type GoogleProviderOptions = ReadonlyDeep<{
	google: {
		thinkingConfig: {
			thinkingBudget?: number;
			thinkingLevel?: GoogleThinkingLevel;
		};
	};
}>;

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

export type ModelProviderResolutionOptions = Readonly<{
	maxOutputTokens?: number;
}> &
	ReasoningSelection;

export type ResolvedModelProviderOptions = Readonly<{
	maxOutputTokens?: number;
	providerOptions?: ModelProviderOptions;
}>;

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
 * Effort ladder (Anthropic 4.5, `gemini-2.5-pro`). A quarter of the model's own
 * output limit reproduces the previous fixed 16000 for a 64000-output model
 * instead of hard-coding it, and stays inside the published bounds.
 */
const REASONING_BUDGET_SHARE = 0.25;

const isListedModel = (
	models: Readonly<Record<string, true>>,
	modelId: string
): boolean => models[modelId] === true;

const unsupportedEffort = (model: SupportedChatModel, effort: string): Error =>
	new Error(
		`Unsupported model Effort: ${model.connectionProviderId}/${model.id}/${effort}`
	);

const unsupportedReasoningMode = (
	model: SupportedChatModel,
	reasoningMode: string
): Error =>
	new Error(
		`Unsupported Reasoning Mode: ${model.connectionProviderId}/${model.id}/${reasoningMode}`
	);

const normalizeEffortOrThrow = (
	model: SupportedChatModel,
	effort: string | undefined
): Effort | undefined => {
	const normalized = normalizeModelEffortForModel(model, effort);
	if (!isUndefined(effort) && isUndefined(normalized)) {
		throw unsupportedEffort(model, effort);
	}
	return normalized;
};

const normalizeReasoningModeOrThrow = (
	model: SupportedChatModel,
	reasoningMode: string | undefined
): ReasoningMode | undefined => {
	const normalized = normalizeReasoningModeForModel(model, reasoningMode);
	if (!isUndefined(reasoningMode) && isUndefined(normalized)) {
		throw unsupportedReasoningMode(model, reasoningMode);
	}
	return normalized;
};

/**
 * Providers whose thinking budget the provider chooses itself, so no budget
 * crosses the wire. Every other model with an Effort ladder and a budget bound
 * sends a named Effort plus a derived budget.
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
 * usable Effort ladder. The result never reaches the output limit — a budget
 * equal to the cap would leave no room for the answer — and never drops below
 * a published minimum. `null` means the output limit is too small to reason
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
	if (isUndefined(requestedOutputTokens) && shouldDerive) {
		return { maxOutputTokens: outputTokens };
	}
	return max;
};

/**
 * Anthropic thinking for one resolved Effort or Mode. Toggle-only models use
 * adaptive thinking; models that publish bounds get a bounded enabled budget.
 * Named Efforts still use the provider's own budget for the listed adaptive
 * models.
 */
const anthropicThinking = (
	model: SupportedChatModel,
	policy: ModelThinkingPolicy,
	outputTokens: number,
	effort: Effort | undefined,
	disabled: boolean
): AnthropicThinking | undefined => {
	if (disabled) {
		return { type: "disabled" };
	}
	if (isListedModel(providerChosenBudgetModels, model.id)) {
		return { type: "adaptive" };
	}
	if (
		isUndefined(effort) &&
		isUndefined(policy.budgetMin) &&
		isUndefined(policy.budgetMax)
	) {
		return { type: "adaptive" };
	}
	const budget = reasoningBudget(policy, outputTokens);
	return isNull(budget)
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
				thinkingConfig: isNull(budget)
					? { thinkingBudget: 0 }
					: { thinkingBudget: budget },
			},
		};
	}
	return {
		anthropic: {
			thinking: isNull(budget)
				? { type: "disabled" }
				: { budgetTokens: budget, type: "enabled" },
		},
	};
};

/**
 * Which provider option shape reaches the wire for one catalog entry.
 * OpenCode Go serves different model families behind one connection, so its
 * entries route by protocol rather than by connection identity.
 */
const reasoningWiring = (model: SupportedChatModel): ReasoningWiring | null => {
	if (model.provider === "opencode-go") {
		return supportsSelectableReasoning(model) ? model.protocol : null;
	}
	return model.provider;
};

const googleThinkingLevel = (
	effort: Effort | undefined
): GoogleThinkingLevel | undefined => {
	switch (effort) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return effort;
		default:
			return;
	}
};

const anthropicEffort = (
	effort: Effort | undefined
): AnthropicEffort | undefined => {
	switch (effort) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return effort;
		default:
			return;
	}
};

const openAIProviderOptions = (
	metadata: ModelMetadataEntry | undefined,
	effort: Effort | undefined,
	reasoningMode: ReasoningMode | undefined
): OpenAIProviderOptions => {
	const reasoningEffort = reasoningMode === "none" ? "none" : effort;
	return {
		openai: {
			store: false,
			...(metadata?.reasoningSummary
				? { reasoningSummary: "detailed" as const }
				: {}),
			...omitUndefined({ reasoningEffort }),
		},
	};
};
const googleThinkingConfig = (
	model: SupportedChatModel,
	effort: Effort | undefined,
	reasoningMode: ReasoningMode | undefined,
	policy: ModelThinkingPolicy,
	outputTokens: number
): GoogleProviderOptions["google"]["thinkingConfig"] => {
	const thinkingLevel = googleThinkingLevel(effort);
	if (!isUndefined(effort) && isUndefined(thinkingLevel)) {
		throw unsupportedEffort(model, effort);
	}
	if (!isUndefined(thinkingLevel)) {
		return { thinkingLevel };
	}
	if (reasoningMode === "none") {
		return { thinkingBudget: 0 };
	}
	if (!(isUndefined(policy.budgetMin) && isUndefined(policy.budgetMax))) {
		const budget = reasoningBudget(policy, outputTokens);
		return isNull(budget) ? { thinkingBudget: 0 } : { thinkingBudget: budget };
	}
	return {};
};

const resolveDefaultReasoning = (
	wiring: ReasoningWiring,
	metadata: ModelMetadataEntry | undefined,
	maxOutputTokens: number | undefined,
	max: Pick<ResolvedModelProviderOptions, "maxOutputTokens">
): ResolvedModelProviderOptions => {
	if (wiring === "openai") {
		return {
			...max,
			providerOptions: openAIProviderOptions(metadata, undefined, undefined),
		};
	}
	const policy = metadata?.thinking;
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
};

/**
 * Translate one selectable Effort or Reasoning Mode into provider options.
 * Budget-only policies keep their automatic behavior when no choice is made.
 */
const resolveReasoning = (
	model: SupportedChatModel,
	metadata: ModelMetadataEntry | undefined,
	selection: ReasoningSelection,
	maxOutputTokens: number | undefined
): ResolvedModelProviderOptions => {
	const { effort, reasoningMode } = selection;
	if (!(isUndefined(effort) || isUndefined(reasoningMode))) {
		throw new Error("Select either an Effort or a Reasoning Mode, not both.");
	}
	const wiring = reasoningWiring(model);
	const max = withMaxOutputTokens(maxOutputTokens);
	if (isNull(wiring)) {
		return max;
	}
	const policy = metadata?.thinking;
	const isSelected = !(isUndefined(effort) && isUndefined(reasoningMode));
	if (!isSelected) {
		return resolveDefaultReasoning(wiring, metadata, maxOutputTokens, max);
	}
	if (!policy) {
		if (!isUndefined(effort)) {
			throw unsupportedEffort(model, effort);
		}
		if (!isUndefined(reasoningMode)) {
			throw unsupportedReasoningMode(model, reasoningMode);
		}
		return max;
	}
	const outputTokens = effectiveOutputTokens(metadata, maxOutputTokens);
	const disabled = reasoningMode === "none";

	if (wiring === "openai") {
		return {
			...max,
			providerOptions: openAIProviderOptions(metadata, effort, reasoningMode),
		};
	}

	if (wiring === "google") {
		const thinkingConfig = googleThinkingConfig(
			model,
			effort,
			reasoningMode,
			policy,
			outputTokens
		);
		const providerOptions: GoogleProviderOptions = {
			google: { thinkingConfig },
		};
		const hasBudget =
			"thinkingBudget" in thinkingConfig &&
			isNumber(thinkingConfig.thinkingBudget) &&
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

	const providerEffort = anthropicEffort(effort);
	if (!isUndefined(effort) && isUndefined(providerEffort)) {
		throw unsupportedEffort(model, effort);
	}
	const thinking = anthropicThinking(
		model,
		policy,
		outputTokens,
		effort,
		disabled
	);
	const providerOptions: AnthropicProviderOptions = {
		anthropic: {
			...omitUndefined({ effort: providerEffort, thinking }),
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
	omitUndefined({ maxOutputTokens });

/**
 * Whether a provider option bag actually says anything. A Google on/off switch
 * with no published budget has no explicit value to send; an empty bag would
 * only add noise to the request.
 */
const hasProviderOptions = (value: unknown): boolean => {
	if (isUndefined(value) || isNull(value)) {
		return false;
	}
	if (typeof value !== "object") {
		return true;
	}
	if (isArray(value)) {
		return value.length > 0;
	}
	return Object.values(value).some(hasProviderOptions);
};

export const resolveModelProviderOptions = (
	model: SupportedChatModel,
	options: ModelProviderResolutionOptions = {}
): ResolvedModelProviderOptions => {
	if (options.effort !== undefined && options.reasoningMode !== undefined) {
		throw new Error("Select either an Effort or a Reasoning Mode, not both.");
	}
	const effort = normalizeEffortOrThrow(model, options.effort);
	const reasoningMode = normalizeReasoningModeOrThrow(
		model,
		options.reasoningMode
	);
	const selection = createReasoningSelection(effort, reasoningMode);
	const resolved = resolveReasoning(
		model,
		getModelMetadata(model),
		selection,
		options.maxOutputTokens
	);
	const providerOptions = isUndefined(resolved.providerOptions)
		? undefined
		: Object.values(resolved.providerOptions)[0];
	return hasProviderOptions(providerOptions)
		? resolved
		: withMaxOutputTokens(options.maxOutputTokens);
};
