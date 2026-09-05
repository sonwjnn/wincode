import {
	type AnthropicProvider,
	anthropic,
	createAnthropic,
} from "@ai-sdk/anthropic";
import { resolveModelProviderOptions } from "@wincode/ai/model-provider-options";
import type { SupportedChatModel } from "@wincode/ai/models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
	toAiSdkProviderOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "anthropic" }>;

const resolve = (
	model: Model,
	provider: AnthropicProvider,
	options: ResolverOptions
): ResolvedModel => {
	const resolvedOptions = resolveModelProviderOptions(model, options);
	return {
		model: provider(model.id),
		modelId: model.id,
		provider: "anthropic",
		providerOptions: toAiSdkProviderOptions(resolvedOptions.providerOptions),
		...(resolvedOptions.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: resolvedOptions.maxOutputTokens }),
	};
};

export const anthropicResolver = defineModelResolver(
	"anthropic",
	(model): model is Model => model.provider === "anthropic",
	{
		resolveWithApiKey: (model, apiKey, options) =>
			resolve(model, createAnthropic({ apiKey }), options),
		resolveWithEnvironment: (model, options) =>
			resolve(model, anthropic, options),
	}
);
