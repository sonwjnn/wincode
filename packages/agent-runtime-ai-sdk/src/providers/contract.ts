import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	type ModelProviderOptions,
	resolveModelProviderOptions,
} from "@wincode/ai/model-provider-options";
import type {
	ModelRuntimeProviderId,
	ModelVariant,
	SupportedChatModel,
	SupportedChatModelId,
} from "@wincode/ai/models";
import type { LanguageModel } from "ai";

export type ResolverOptions = {
	variant?: ModelVariant;
	maxOutputTokens?: number;
};

export type ResolvedModel = {
	model: LanguageModel;
	modelId: SupportedChatModelId;
	provider: ModelRuntimeProviderId;
	maxOutputTokens?: number;
	providerOptions?: ProviderOptions;
};

export const toAiSdkProviderOptions = (
	options: ModelProviderOptions | undefined
): ProviderOptions | undefined => {
	if (options === undefined) {
		return;
	}
	if ("openai" in options) {
		return { openai: { ...options.openai } };
	}
	if ("anthropic" in options) {
		return { anthropic: { ...options.anthropic } };
	}
	return {
		google: {
			thinkingConfig: { ...options.google.thinkingConfig },
		},
	};
};
export const resolveModelWithProvider = <P extends ModelRuntimeProviderId>(
	model: Extract<SupportedChatModel, { provider: P }>,
	provider: (modelId: string) => LanguageModel,
	options: ResolverOptions
): ResolvedModel => {
	const resolvedOptions = resolveModelProviderOptions(model, options);
	return {
		model: provider(model.id),
		modelId: model.id,
		provider: model.provider,
		...(resolvedOptions.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: resolvedOptions.maxOutputTokens }),
		...(resolvedOptions.providerOptions === undefined
			? {}
			: {
					providerOptions: toAiSdkProviderOptions(
						resolvedOptions.providerOptions
					),
				}),
	};
};

export type ModelResolver<P extends ModelRuntimeProviderId> = {
	provider: P;
	resolveWithApiKey(
		model: Extract<SupportedChatModel, { provider: P }>,
		apiKey: string,
		options: ResolverOptions
	): ResolvedModel;
	resolveWithEnvironment(
		model: Extract<SupportedChatModel, { provider: P }>,
		options: ResolverOptions
	): ResolvedModel;
};

export type BroadResolver<P extends ModelRuntimeProviderId> = {
	provider: P;
	resolveWithApiKey(
		model: SupportedChatModel,
		apiKey: string,
		options: ResolverOptions
	): ResolvedModel;
	resolveWithEnvironment(
		model: SupportedChatModel,
		options: ResolverOptions
	): ResolvedModel;
};

export function defineModelResolver<P extends ModelRuntimeProviderId>(
	provider: P,
	isModel: (
		model: SupportedChatModel
	) => model is Extract<SupportedChatModel, { provider: P }>,
	resolver: Omit<ModelResolver<P>, "provider">
): BroadResolver<P> {
	const narrow = (
		model: SupportedChatModel
	): Extract<SupportedChatModel, { provider: P }> => {
		if (!isModel(model)) {
			throw new Error(`Unsupported provider: ${model.provider}`);
		}
		return model;
	};
	return {
		provider,
		resolveWithApiKey: (model, key, options) =>
			resolver.resolveWithApiKey(narrow(model), key, options),
		resolveWithEnvironment: (model, options) =>
			resolver.resolveWithEnvironment(narrow(model), options),
	};
}
