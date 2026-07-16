import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import {
	type ChatModelSelection,
	findSupportedChatModel,
	findSupportedChatModelSelection,
	type ModelVariant,
	normalizeChatModelSelection,
	normalizeModelVariant,
	type SupportedChatModel,
	type SupportedChatModelId,
	type SupportedProvider,
} from "../models";

type AnthropicModelId = Extract<
	SupportedChatModel,
	{ provider: "anthropic" }
>["id"];
type GoogleModelId = Extract<SupportedChatModel, { provider: "google" }>["id"];
type OpenAIModelId = Extract<SupportedChatModel, { provider: "openai" }>["id"];

export type ResolvedModel = {
	model: LanguageModel;
	modelId: SupportedChatModelId;
	provider: SupportedProvider;
	maxOutputTokens?: number;
	providerOptions?: ProviderOptions;
};
export type OpenAIResolverOptions = {
	accessToken: string;
	accountId?: string;
	originator?: string;
};
export type DirectModelResolverOptions = {
	variant?: ModelVariant;
	maxOutputTokens?: number;
};

const OUTPUT_TOKEN_MAX = 32_000;

const OPENAI_PROVIDER_OPTIONS: Partial<Record<OpenAIModelId, ProviderOptions>> =
	{
		"gpt-5.4-mini": { openai: { reasoningSummary: "detailed", store: false } },
		"gpt-5.5": { openai: { reasoningSummary: "detailed", store: false } },
		"gpt-5.6-sol": { openai: { reasoningSummary: "detailed", store: false } },
		"gpt-5.6-terra": { openai: { reasoningSummary: "detailed", store: false } },
		"gpt-5.6-luna": { openai: { reasoningSummary: "detailed", store: false } },
	};

const ANTHROPIC_ADAPTIVE_MODELS = new Set<AnthropicModelId>([
	"claude-opus-4-7",
	"claude-sonnet-5",
	"claude-opus-4-8",
	"claude-fable-5",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
]);
const ANTHROPIC_MANUAL_EFFORT_MODELS = new Set<AnthropicModelId>([
	"claude-opus-4-5",
	"claude-opus-4-5-20251101",
]);
const ANTHROPIC_BUDGET_MODELS = new Map<
	AnthropicModelId,
	{ high: number; max: number }
>([
	["claude-haiku-4-5", { high: 16_000, max: 31_999 }],
	["claude-haiku-4-5-20251001", { high: 16_000, max: 31_999 }],
	["claude-sonnet-4-5", { high: 16_000, max: 31_999 }],
	["claude-sonnet-4-5-20250929", { high: 16_000, max: 31_999 }],
]);

const GOOGLE_LEVEL_MODELS = new Set<GoogleModelId>([
	"gemini-3.1-flash-lite",
	"gemini-3.5-flash",
	"gemini-3-flash-preview",
	"gemini-3.1-pro-preview",
	"gemini-3-pro-preview",
]);
const GOOGLE_BUDGET_MODELS = new Map<
	GoogleModelId,
	{ high: number; max: number }
>([
	["gemini-2.5-pro", { high: 16_000, max: 31_999 }],
	["gemini-2.5-flash", { high: 12_288, max: 24_576 }],
	["gemini-flash-latest", { high: 12_288, max: 24_576 }],
	["gemini-flash-lite-latest", { high: 12_288, max: 24_576 }],
	["gemini-2.5-flash-lite", { high: 12_288, max: 24_576 }],
]);

function buildAnthropicOptions(
	modelId: AnthropicModelId,
	variant?: ModelVariant,
	maxOutputTokens?: number
): ProviderOptions | undefined {
	const normalizedVariant = normalizeModelVariant(
		{ modelId, providerId: "anthropic" },
		variant
	);
	if (!normalizedVariant) {
		return;
	}
	if (ANTHROPIC_ADAPTIVE_MODELS.has(modelId)) {
		return {
			anthropic: {
				effort: normalizedVariant,
				thinking: { type: "adaptive" },
			},
		};
	}
	if (ANTHROPIC_MANUAL_EFFORT_MODELS.has(modelId)) {
		const budgetTokens = 16_000;
		const maximumOutputTokens = Math.min(
			maxOutputTokens ?? OUTPUT_TOKEN_MAX,
			OUTPUT_TOKEN_MAX
		);
		if (budgetTokens >= maximumOutputTokens) {
			throw new Error(
				`Invalid Anthropic budget for ${modelId}: ${budgetTokens} must be less than ${maximumOutputTokens}`
			);
		}
		return {
			anthropic: {
				effort: normalizedVariant,
				thinking: { type: "enabled", budgetTokens },
			},
		};
	}
	const budget = ANTHROPIC_BUDGET_MODELS.get(modelId);
	if (!budget) {
		return;
	}
	if (normalizedVariant !== "high" && normalizedVariant !== "max") {
		return;
	}
	const budgetTokens = budget[normalizedVariant];
	const maximumOutputTokens = Math.min(
		maxOutputTokens ?? OUTPUT_TOKEN_MAX,
		OUTPUT_TOKEN_MAX
	);
	if (budgetTokens >= maximumOutputTokens) {
		throw new Error(
			`Invalid Anthropic budget for ${modelId}: ${budgetTokens} must be less than ${maximumOutputTokens}`
		);
	}
	return { anthropic: { thinking: { type: "enabled", budgetTokens } } };
}

function buildGoogleOptions(
	modelId: GoogleModelId,
	variant?: ModelVariant,
	maxOutputTokens?: number
): ProviderOptions | undefined {
	const normalizedVariant = normalizeModelVariant(
		{ modelId, providerId: "google" },
		variant
	);
	if (!normalizedVariant) {
		return;
	}
	if (GOOGLE_LEVEL_MODELS.has(modelId)) {
		return { google: { thinkingConfig: { thinkingLevel: normalizedVariant } } };
	}
	const budget = GOOGLE_BUDGET_MODELS.get(modelId);
	if (!budget) {
		return;
	}
	if (normalizedVariant !== "high" && normalizedVariant !== "max") {
		return;
	}
	const budgetTokens = budget[normalizedVariant];
	const maximumOutputTokens = Math.min(
		maxOutputTokens ?? OUTPUT_TOKEN_MAX,
		OUTPUT_TOKEN_MAX
	);
	if (budgetTokens >= maximumOutputTokens) {
		throw new Error(
			`Invalid Google budget for ${modelId}: ${budgetTokens} must be less than ${maximumOutputTokens}`
		);
	}
	return { google: { thinkingConfig: { thinkingBudget: budgetTokens } } };
}

function resolveMaxOutputTokens(
	modelId: string,
	variant: ModelVariant | undefined,
	requestedMaxOutputTokens: number | undefined
): number | undefined {
	if (!variant) {
		return;
	}
	if (
		ANTHROPIC_MANUAL_EFFORT_MODELS.has(modelId as AnthropicModelId) ||
		ANTHROPIC_BUDGET_MODELS.has(modelId as AnthropicModelId) ||
		GOOGLE_BUDGET_MODELS.has(modelId as GoogleModelId)
	) {
		return Math.min(
			requestedMaxOutputTokens ?? OUTPUT_TOKEN_MAX,
			OUTPUT_TOKEN_MAX
		);
	}
	return;
}

function resolveVariantOrThrow(
	selection: ChatModelSelection,
	variant?: ModelVariant
): ModelVariant | undefined {
	if (variant === undefined) {
		return;
	}
	if (!normalizeModelVariant(selection, variant)) {
		throw new Error(
			`Unsupported model variant: ${selection.providerId}/${selection.modelId}/${variant}`
		);
	}
	return variant;
}

function getOpenAIProviderOptions(
	modelId: string
): ProviderOptions | undefined {
	const providerOptions = Object.entries(OPENAI_PROVIDER_OPTIONS).find(
		([candidateId]) => candidateId === modelId
	)?.[1];
	return { openai: { store: false, ...providerOptions?.openai } };
}

function buildOpenAIOptions(
	modelId: string,
	variant?: ModelVariant
): ProviderOptions | undefined {
	if (variant === undefined) {
		return getOpenAIProviderOptions(modelId);
	}
	return {
		openai: {
			...getOpenAIProviderOptions(modelId)?.openai,
			reasoningEffort: variant,
		},
	};
}

function combineProviderOptions(
	base?: ProviderOptions,
	override?: ProviderOptions
): ProviderOptions | undefined {
	if (!base) {
		return override;
	}
	if (!override) {
		return base;
	}
	return {
		...base,
		...override,
		...(base.openai || override.openai
			? { openai: { ...base.openai, ...override.openai } }
			: {}),
		...(base.anthropic || override.anthropic
			? { anthropic: { ...base.anthropic, ...override.anthropic } }
			: {}),
		...(base.google || override.google
			? { google: { ...base.google, ...override.google } }
			: {}),
	};
}

export function resolveDirectChatModel(
	selection: ChatModelSelection,
	apiKey: string,
	options: DirectModelResolverOptions = {}
): ResolvedModel {
	const normalized = normalizeChatModelSelection(selection);
	if (!normalized) {
		throw new Error(
			`Unsupported direct chat model selection: ${selection.providerId}/${selection.modelId}`
		);
	}
	const supported = findSupportedChatModelSelection(normalized);
	if (!supported || supported.connectionProviderId === "wincode") {
		throw new Error(
			`Direct chat model selection must use openai, anthropic, or google: ${normalized.providerId}/${normalized.modelId}`
		);
	}
	const resolvedVariant = resolveVariantOrThrow(normalized, options.variant);
	if (supported.provider === "openai") {
		const provider = createOpenAI({ apiKey });
		return {
			model: provider(supported.id),
			modelId: supported.id,
			provider: "openai",
			providerOptions: combineProviderOptions(
				OPENAI_PROVIDER_OPTIONS[supported.id],
				buildOpenAIOptions(supported.id, resolvedVariant)
			),
		};
	}
	if (supported.provider === "anthropic") {
		const provider = createAnthropic({ apiKey });
		return {
			model: provider(supported.id),
			modelId: supported.id,
			provider: "anthropic",
			providerOptions: buildAnthropicOptions(
				supported.id,
				resolvedVariant,
				options.maxOutputTokens
			),
			maxOutputTokens: resolveMaxOutputTokens(
				supported.id,
				resolvedVariant,
				options.maxOutputTokens
			),
		};
	}
	const provider = createGoogleGenerativeAI({ apiKey });
	return {
		model: provider(supported.id),
		modelId: supported.id,
		provider: "google",
		providerOptions: buildGoogleOptions(
			supported.id,
			resolvedVariant,
			options.maxOutputTokens
		),
		maxOutputTokens: resolveMaxOutputTokens(
			supported.id,
			resolvedVariant,
			options.maxOutputTokens
		),
	};
}

export function resolveOpenAIChatModel(
	modelId: string,
	options: OpenAIResolverOptions,
	variantOptions: DirectModelResolverOptions = {}
): ResolvedModel {
	const supported = findSupportedChatModelSelection({
		modelId,
		providerId: "openai",
	});
	if (!supported) {
		throw new Error(`Unsupported OpenAI model: ${modelId}`);
	}
	const resolvedVariant = resolveVariantOrThrow(
		{ modelId, providerId: "openai" },
		variantOptions.variant
	);
	const provider = createOpenAI({
		apiKey: options.accessToken,
		baseURL: "https://chatgpt.com/backend-api/codex",
		headers: {
			"ChatGPT-Account-Id": options.accountId ?? "",
			"OpenAI-Beta": "responses=experimental",
			originator: options.originator ?? "wincode",
		},
	});
	return {
		model: provider.responses(supported.id),
		modelId: supported.id,
		provider: "openai",
		providerOptions: combineProviderOptions(
			getOpenAIProviderOptions(supported.id),
			buildOpenAIOptions(supported.id, resolvedVariant)
		),
	};
}

export function resolveSupportedChatModel(
	model: SupportedChatModel,
	options: DirectModelResolverOptions = {}
): ResolvedModel {
	switch (model.provider) {
		case "anthropic": {
			const anthropicVariant = resolveVariantOrThrow(
				{ modelId: model.id, providerId: "anthropic" },
				options.variant
			);
			return {
				model: createAnthropic({ apiKey: "" })(model.id),
				modelId: model.id,
				provider: "anthropic",
				providerOptions: buildAnthropicOptions(
					model.id,
					anthropicVariant,
					options.maxOutputTokens
				),
				maxOutputTokens: resolveMaxOutputTokens(
					model.id,
					anthropicVariant,
					options.maxOutputTokens
				),
			};
		}
		case "google": {
			const googleVariant = resolveVariantOrThrow(
				{ modelId: model.id, providerId: "google" },
				options.variant
			);
			return {
				model: google(model.id),
				modelId: model.id,
				provider: "google",
				providerOptions: buildGoogleOptions(
					model.id,
					googleVariant,
					options.maxOutputTokens
				),
				maxOutputTokens: resolveMaxOutputTokens(
					model.id,
					googleVariant,
					options.maxOutputTokens
				),
			};
		}
		case "openai": {
			const openaiVariant = resolveVariantOrThrow(
				{ modelId: model.id, providerId: "openai" },
				options.variant
			);
			return {
				model: openai(model.id),
				modelId: model.id,
				provider: "openai",
				providerOptions: combineProviderOptions(
					OPENAI_PROVIDER_OPTIONS[model.id],
					buildOpenAIOptions(model.id, openaiVariant)
				),
				maxOutputTokens: resolveMaxOutputTokens(
					model.id,
					openaiVariant,
					options.maxOutputTokens
				),
			};
		}
		default:
			throw new Error("Unsupported provider");
	}
}

export function isSupportedChatModel(
	modelId: string
): modelId is SupportedChatModelId {
	return findSupportedChatModel(modelId) !== null;
}
export function isSupportedChatModelSelection(
	selection: ChatModelSelection
): boolean {
	return findSupportedChatModelSelection(selection) !== null;
}
export function isHostChatModelSelection(
	selection: ChatModelSelection
): boolean {
	return selection.providerId === "wincode";
}
export function resolveHostChatModelSelection(
	modelId: string
): ChatModelSelection {
	const selection = normalizeChatModelSelection(modelId);
	if (selection?.providerId !== "wincode") {
		throw new Error(`Unsupported host model: ${modelId}`);
	}
	return selection;
}
export function resolveWincodeChatModelSelection(
	modelId: string
): SupportedChatModel {
	const selection = resolveHostChatModelSelection(modelId);
	const supported = findSupportedChatModelSelection(selection);
	if (supported?.connectionProviderId !== "wincode") {
		throw new Error(`Unsupported host model: ${modelId}`);
	}
	return supported;
}
export function resolveChatModel(modelId: string): ResolvedModel {
	const model = findSupportedChatModel(modelId);
	if (!model) {
		throw new Error(`Unsupported model: ${modelId}`);
	}
	return resolveSupportedChatModel(model);
}
