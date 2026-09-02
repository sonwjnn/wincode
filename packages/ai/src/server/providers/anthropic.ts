import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { resolveModelProviderOptions } from "../../model-provider-options";
import type { SupportedChatModel } from "../../models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
	toAiSdkProviderOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "anthropic" }>;
const resolve = (
	model: Model,
	provider: ReturnType<typeof createAnthropic>,
	opts: ResolverOptions
): ResolvedModel => {
	const resolvedOptions = resolveModelProviderOptions(model, {
		maxOutputTokens: opts.maxOutputTokens,
		variant: opts.variant,
	});
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
	(m): m is Model => m.provider === "anthropic",
	{
		resolveWithApiKey: (m, key, opts) =>
			resolve(m, createAnthropic({ apiKey: key }), opts),
		resolveWithEnvironment: (m, opts) => resolve(m, anthropic, opts),
	}
);
