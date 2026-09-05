import { createOpenAI, type OpenAIProvider, openai } from "@ai-sdk/openai";
import { resolveModelProviderOptions } from "@wincode/ai/model-provider-options";
import {
	findSupportedChatModelSelection,
	type SupportedChatModel,
} from "@wincode/ai/models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
	toAiSdkProviderOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "openai" }>;

const resolve = (
	model: Model,
	provider: OpenAIProvider,
	variant?: ResolverOptions["variant"]
): ResolvedModel => {
	const resolvedOptions = resolveModelProviderOptions(model, { variant });
	return {
		model: provider(model.id),
		modelId: model.id,
		provider: "openai",
		providerOptions: toAiSdkProviderOptions(resolvedOptions.providerOptions),
	};
};

export const openAIResolver = defineModelResolver(
	"openai",
	(model): model is Model => model.provider === "openai",
	{
		resolveWithApiKey: (model, apiKey, options) =>
			resolve(model, createOpenAI({ apiKey }), options.variant),
		resolveWithEnvironment: (model, options) =>
			resolve(model, openai, options.variant),
	}
);

export type OpenAIResolverOptions = {
	accessToken: string;
	accountId?: string;
	originator?: string;
};

export function resolveOpenAIChatModel(
	model: string,
	auth: OpenAIResolverOptions,
	options: ResolverOptions = {}
): ResolvedModel {
	const supported = findSupportedChatModelSelection({
		modelId: model,
		providerId: "openai",
	});
	if (
		supported?.provider !== "openai" ||
		supported.connectionProviderId !== "openai"
	) {
		throw new Error(`Unsupported OpenAI model: ${model}`);
	}
	const provider = createOpenAI({
		apiKey: auth.accessToken,
		baseURL: "https://chatgpt.com/backend-api/codex",
		headers: {
			"ChatGPT-Account-Id": auth.accountId ?? "",
			"OpenAI-Beta": "responses=experimental",
			originator: auth.originator ?? "wincode",
		},
	});
	return {
		...resolve(supported, provider, options.variant),
		model: provider.responses(supported.id),
	};
}
