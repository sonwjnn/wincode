import {
	createGoogleGenerativeAI,
	type GoogleGenerativeAIProvider,
	google,
} from "@ai-sdk/google";
import { resolveModelProviderOptions } from "@wincode/ai/model-provider-options";
import type { SupportedChatModel } from "@wincode/ai/models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
	toAiSdkProviderOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "google" }>;

const resolve = (
	model: Model,
	provider: GoogleGenerativeAIProvider,
	options: ResolverOptions
): ResolvedModel => {
	const resolvedOptions = resolveModelProviderOptions(model, options);
	return {
		model: provider(model.id),
		modelId: model.id,
		provider: "google",
		providerOptions: toAiSdkProviderOptions(resolvedOptions.providerOptions),
		...(resolvedOptions.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: resolvedOptions.maxOutputTokens }),
	};
};

export const googleResolver = defineModelResolver(
	"google",
	(model): model is Model => model.provider === "google",
	{
		resolveWithApiKey: (model, apiKey, options) =>
			resolve(model, createGoogleGenerativeAI({ apiKey }), options),
		resolveWithEnvironment: (model, options) => resolve(model, google, options),
	}
);
