import type {
	AnthropicProviderOptions,
	GoogleProviderOptions,
	ModelProviderOptions,
	OpenAIProviderOptions,
} from "../../model-provider-options";
import type { ProviderRequestContext } from "./types";

export const mergeProviderOptions = (
	resolved: ModelProviderOptions | undefined,
	target: ModelProviderOptions | undefined
): ModelProviderOptions | undefined => {
	if (!resolved) {
		return target;
	}
	if (!target) {
		return resolved;
	}
	if ("openai" in resolved && "openai" in target) {
		return { openai: { ...resolved.openai, ...target.openai } };
	}
	if ("anthropic" in resolved && "anthropic" in target) {
		return { anthropic: { ...resolved.anthropic, ...target.anthropic } };
	}
	if ("google" in resolved && "google" in target) {
		return {
			google: {
				thinkingConfig: {
					...resolved.google.thinkingConfig,
					...target.google.thinkingConfig,
				},
			},
		};
	}
	return target;
};

export const openAIOptionsFor = (
	options: ModelProviderOptions | undefined
): OpenAIProviderOptions["openai"] | undefined =>
	options && "openai" in options ? options.openai : undefined;

export const anthropicOptionsFor = (
	options: ModelProviderOptions | undefined
): AnthropicProviderOptions["anthropic"] | undefined =>
	options && "anthropic" in options ? options.anthropic : undefined;

export const googleOptionsFor = (
	options: ModelProviderOptions | undefined
): GoogleProviderOptions["google"] | undefined =>
	options && "google" in options ? options.google : undefined;

export const requireApiKey = (
	context: ProviderRequestContext,
	message: string
): string => {
	const authorization = context.request.target.authorization;
	if (authorization.kind !== "api-key") {
		throw new Error(message);
	}
	return authorization.apiKey;
};
