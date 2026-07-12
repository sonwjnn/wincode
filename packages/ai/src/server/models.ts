import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import {
	type ChatModelSelection,
	findSupportedChatModel,
	findSupportedChatModelSelection,
	normalizeChatModelSelection,
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
	providerOptions?: ProviderOptions;
};

export type OpenAIResolverOptions = {
	accessToken: string;
	accountId?: string;
	originator?: string;
};

const ANTHROPIC_PROVIDER_OPTIONS: Partial<
	Record<AnthropicModelId, ProviderOptions>
> = {
	"claude-opus-4-8": {
		anthropic: {
			thinking: {
				budgetTokens: 10_000,
				type: "enabled",
			},
		},
	},
	"claude-sonnet-5": {
		anthropic: {
			thinking: {
				budgetTokens: 10_000,
				type: "enabled",
			},
		},
	},
};

const GOOGLE_PROVIDER_OPTIONS: Partial<Record<GoogleModelId, ProviderOptions>> =
	{
		"gemini-2.5-flash": {
			google: {
				thinkingConfig: {
					includeThoughts: true,
				},
			},
		},
	};

const OPENAI_PROVIDER_OPTIONS: Partial<Record<OpenAIModelId, ProviderOptions>> =
	{
		"gpt-5.4-mini": {
			openai: {
				reasoningSummary: "detailed",
				store: false,
			},
		},
		"gpt-5.5": {
			openai: {
				reasoningSummary: "detailed",
				store: false,
			},
		},
		"gpt-5.6-sol": {
			openai: {
				reasoningSummary: "detailed",
				store: false,
			},
		},
		"gpt-5.6-terra": {
			openai: {
				reasoningSummary: "detailed",
				store: false,
			},
		},
		"gpt-5.6-luna": {
			openai: {
				reasoningSummary: "detailed",
				store: false,
			},
		},
	};

function resolveAnthropicModel(modelId: AnthropicModelId): ResolvedModel {
	return {
		model: anthropic(modelId),
		modelId,
		provider: "anthropic",
		providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
	};
}

function resolveGoogleModel(modelId: GoogleModelId): ResolvedModel {
	return {
		model: google(modelId),
		modelId,
		provider: "google",
		providerOptions: GOOGLE_PROVIDER_OPTIONS[modelId],
	};
}

function resolveOpenAIModel(modelId: OpenAIModelId): ResolvedModel {
	return {
		model: openai(modelId),
		modelId,
		provider: "openai",
		providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
	};
}

export function resolveDirectChatModel(
	selection: ChatModelSelection,
	apiKey: string
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
			`Direct chat model selection must use openai or anthropic: ${normalized.providerId}/${normalized.modelId}`
		);
	}

	if (
		supported.provider === "openai" &&
		supported.connectionProviderId === "openai"
	) {
		const provider = createOpenAI({ apiKey });
		return {
			model: provider(supported.id),
			modelId: supported.id,
			provider: "openai",
			providerOptions: OPENAI_PROVIDER_OPTIONS[supported.id as OpenAIModelId],
		};
	}

	if (
		supported.provider === "anthropic" &&
		supported.connectionProviderId === "anthropic"
	) {
		const provider = createAnthropic({ apiKey });
		return {
			model: provider(supported.id),
			modelId: supported.id,
			provider: "anthropic",
			providerOptions:
				ANTHROPIC_PROVIDER_OPTIONS[supported.id as AnthropicModelId],
		};
	}

	throw new Error(
		`Unsupported direct chat model selection: ${normalized.providerId}/${normalized.modelId}`
	);
}

export function resolveOpenAIChatModel(
	modelId: OpenAIModelId,
	options: OpenAIResolverOptions
): ResolvedModel {
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
		model: provider.responses(modelId),
		modelId,
		provider: "openai",
		providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
	};
}

export function resolveSupportedChatModel(
	model: SupportedChatModel
): ResolvedModel {
	const provider = model.provider;

	switch (provider) {
		case "anthropic":
			return resolveAnthropicModel(model.id);
		case "google":
			return resolveGoogleModel(model.id);
		case "openai":
			return resolveOpenAIModel(model.id);
		default:
			throw new Error(`Unsupported provider: ${provider}`);
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
	if (!selection || selection.providerId !== "wincode") {
		throw new Error(`Unsupported host model: ${modelId}`);
	}

	return selection;
}

export function resolveWincodeChatModelSelection(
	modelId: string
): SupportedChatModel {
	const selection = resolveHostChatModelSelection(modelId);
	const supported = findSupportedChatModelSelection(selection);
	if (!supported || supported.connectionProviderId !== "wincode") {
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
