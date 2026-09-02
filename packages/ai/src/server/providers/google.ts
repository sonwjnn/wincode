import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { resolveModelProviderOptions } from "../../model-provider-options";
import type { SupportedChatModel } from "../../models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
	toAiSdkProviderOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "google" }>;
const resolve = (
	model: Model,
	provider: ReturnType<typeof createGoogleGenerativeAI>,
	opts: ResolverOptions
): ResolvedModel => {
	const resolvedOptions = resolveModelProviderOptions(model, {
		maxOutputTokens: opts.maxOutputTokens,
		variant: opts.variant,
	});
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
	(m): m is Model => m.provider === "google",
	{
		resolveWithApiKey: (m, key, opts) =>
			resolve(m, createGoogleGenerativeAI({ apiKey: key }), opts),
		resolveWithEnvironment: (m, opts) => resolve(m, google, opts),
	}
);
