import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import {
	findSupportedChatModel,
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

const ANTHROPIC_PROVIDER_OPTIONS: Partial<
	Record<AnthropicModelId, ProviderOptions>
> = {
	"claude-opus-4.8": {
		anthropic: {
			thinking: {
				budgetTokens: 10_000,
				type: "enabled",
			},
		},
	},
	"claude-sonnet-4.6": {
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
		"gemini-3.5-flash": {
			google: {
				thinkingConfig: {
					includeThoughts: true,
				},
			},
		},
		"gemini-3.1-pro-preview": {
			google: {
				thinkingConfig: {
					includeThoughts: true,
				},
			},
		},
		"gemini-2.5-pro": {
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
			},
		},
		"gpt-5.5": {
			openai: {
				reasoningSummary: "detailed",
			},
		},
		"gpt-5.5-pro": {
			openai: {
				reasoningSummary: "detailed",
			},
		},
		"gpt-5.4-mini-fast": {
			openai: {
				reasoningSummary: "detailed",
			},
		},
	};

function assertUnsupportedProvider(provider: never): never {
	throw new Error(`Unsupported provider: ${provider}`);
}

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
			return assertUnsupportedProvider(provider);
	}
}

export function isSupportedChatModel(
	modelId: string
): modelId is SupportedChatModelId {
	return findSupportedChatModel(modelId) !== null;
}

export function resolveChatModel(modelId: string): ResolvedModel {
	const model = findSupportedChatModel(modelId);
	if (!model) {
		throw new Error(`Unsupported model: ${modelId}`);
	}

	return resolveSupportedChatModel(model);
}
