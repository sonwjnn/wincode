import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import type { ModelProviderOptions } from "../../model-provider-options";
import type {
	ModelVariant,
	SupportedChatModel,
	SupportedChatModelId,
	SupportedProvider,
} from "../../models";

export type ResolverOptions = {
	variant?: ModelVariant;
	maxOutputTokens?: number;
};
export type ResolvedModel = {
	model: LanguageModel;
	modelId: SupportedChatModelId;
	provider: SupportedProvider;
	maxOutputTokens?: number;
	providerOptions?: ProviderOptions;
};
export const toAiSdkProviderOptions = (
	options: ModelProviderOptions | undefined
): ProviderOptions | undefined => options as ProviderOptions | undefined;
export type ModelResolver<P extends SupportedProvider> = {
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
export type BroadResolver<P extends SupportedProvider> = {
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

export function defineModelResolver<P extends SupportedProvider>(
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
