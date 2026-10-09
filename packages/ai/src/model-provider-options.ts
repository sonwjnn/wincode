import {
	isArray,
	isNull,
	isNumber,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import type { ReadonlyDeep } from "type-fest";
import { z } from "zod";
import type { ModelMetadataEntry } from "./model-metadata";
import {
	getModelMetadata,
	getModelThinkingLevelValue,
	normalizeThinkingLevelForModel,
} from "./model-metadata-runtime";
import {
	type ConnectionProviderId,
	type ModelThinkingPolicy,
	type SupportedChatModel,
	supportsSelectableReasoning,
	type ThinkingLevel,
	type ThinkingSelection,
} from "./models";

export type OpenAIReasoningEffort = Exclude<ThinkingLevel, "off"> | "none";
export type AnthropicEffort = Exclude<ThinkingLevel, "minimal" | "off">;
export type GoogleThinkingLevel = Exclude<
	ThinkingLevel,
	"off" | "xhigh" | "max"
>;

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
	ThinkingSelection;

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

const unsupportedThinkingLevel = (
	model: SupportedChatModel,
	thinkingLevel: string
): Error =>
	new Error(
		`Unsupported Thinking level: ${model.connectionProviderId}/${model.id}/${thinkingLevel}`
	);

const normalizeThinkingLevelOrThrow = (
	model: SupportedChatModel,
	thinkingLevel: string | undefined
): ThinkingLevel | undefined => {
	const normalized = normalizeThinkingLevelForModel(model, thinkingLevel);
	if (!isUndefined(thinkingLevel) && isUndefined(normalized)) {
		throw unsupportedThinkingLevel(model, thinkingLevel);
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
 * Anthropic thinking for one resolved Thinking level. Toggle-only models use
 * adaptive thinking; models that publish bounds get a bounded enabled budget.
 * Named levels still use the provider's own budget for listed adaptive models.
 */
const anthropicThinking = (
	model: SupportedChatModel,
	policy: ModelThinkingPolicy,
	outputTokens: number,
	nativeThinkingLevel: string | undefined,
	disabled: boolean
): AnthropicThinking | undefined => {
	if (disabled) {
		return { type: "disabled" };
	}
	if (isListedModel(providerChosenBudgetModels, model.id)) {
		return { type: "adaptive" };
	}
	if (
		(isUndefined(nativeThinkingLevel) || nativeThinkingLevel === "thinking") &&
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
	nativeThinkingLevel: string | undefined
): GoogleThinkingLevel | undefined => {
	switch (nativeThinkingLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return nativeThinkingLevel;
		default:
			return;
	}
};

const anthropicEffort = (
	nativeThinkingLevel: string | undefined
): AnthropicEffort | undefined => {
	switch (nativeThinkingLevel) {
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return nativeThinkingLevel;
		default:
			return;
	}
};

const openAIReasoningEffort = (
	nativeThinkingLevel: string | undefined
): OpenAIReasoningEffort | undefined => {
	if (nativeThinkingLevel === "off") {
		return "none";
	}
	switch (nativeThinkingLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max":
			return nativeThinkingLevel;
		default:
			return;
	}
};

const openAIProviderOptions = (
	metadata: ModelMetadataEntry | undefined,
	nativeThinkingLevel: string | undefined
): OpenAIProviderOptions => {
	const reasoningEffort =
		nativeThinkingLevel === "thinking"
			? undefined
			: openAIReasoningEffort(nativeThinkingLevel);
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
	nativeThinkingLevel: string,
	policy: ModelThinkingPolicy,
	outputTokens: number
): GoogleProviderOptions["google"]["thinkingConfig"] => {
	if (nativeThinkingLevel === "off") {
		return { thinkingBudget: 0 };
	}
	const thinkingLevel = googleThinkingLevel(nativeThinkingLevel);
	if (thinkingLevel) {
		return { thinkingLevel };
	}
	if (nativeThinkingLevel !== "thinking") {
		throw unsupportedThinkingLevel(model, nativeThinkingLevel);
	}
	const budget = reasoningBudget(policy, outputTokens);
	return isNull(budget) ? { thinkingBudget: 0 } : { thinkingBudget: budget };
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
			providerOptions: openAIProviderOptions(metadata, undefined),
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
 * Translate one unified Thinking level into provider options. Budget-only
 * policies keep their automatic behavior when no choice is made.
 */
const resolveReasoning = (
	model: SupportedChatModel,
	metadata: ModelMetadataEntry | undefined,
	selection: ThinkingSelection,
	maxOutputTokens: number | undefined
): ResolvedModelProviderOptions => {
	const { thinkingLevel } = selection;
	const wiring = reasoningWiring(model);
	const max = withMaxOutputTokens(maxOutputTokens);
	if (isNull(wiring)) {
		return max;
	}
	const policy = metadata?.thinking;
	if (isUndefined(thinkingLevel)) {
		return resolveDefaultReasoning(wiring, metadata, maxOutputTokens, max);
	}
	if (!policy) {
		throw unsupportedThinkingLevel(model, thinkingLevel);
	}
	const nativeThinkingLevel = getModelThinkingLevelValue(model, thinkingLevel);
	if (isUndefined(nativeThinkingLevel)) {
		throw unsupportedThinkingLevel(model, thinkingLevel);
	}
	const outputTokens = effectiveOutputTokens(metadata, maxOutputTokens);
	const disabled = nativeThinkingLevel === "off";

	if (wiring === "openai") {
		const reasoningEffort = openAIReasoningEffort(nativeThinkingLevel);
		if (nativeThinkingLevel !== "thinking" && isUndefined(reasoningEffort)) {
			throw unsupportedThinkingLevel(model, thinkingLevel);
		}
		return {
			...max,
			providerOptions: openAIProviderOptions(metadata, nativeThinkingLevel),
		};
	}

	if (wiring === "google") {
		const thinkingConfig = googleThinkingConfig(
			model,
			nativeThinkingLevel,
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

	const providerEffort = anthropicEffort(nativeThinkingLevel);
	if (
		nativeThinkingLevel !== "off" &&
		nativeThinkingLevel !== "thinking" &&
		isUndefined(providerEffort)
	) {
		throw unsupportedThinkingLevel(model, thinkingLevel);
	}
	const thinking = anthropicThinking(
		model,
		policy,
		outputTokens,
		nativeThinkingLevel,
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
	const thinkingLevel = normalizeThinkingLevelOrThrow(
		model,
		options.thinkingLevel
	);
	const resolved = resolveReasoning(
		model,
		getModelMetadata(model),
		{ thinkingLevel },
		options.maxOutputTokens
	);
	const providerOptions = isUndefined(resolved.providerOptions)
		? undefined
		: Object.values(resolved.providerOptions)[0];
	return hasProviderOptions(providerOptions)
		? resolved
		: withMaxOutputTokens(options.maxOutputTokens);
};
