import { createOpenAI, openai } from "@ai-sdk/openai";
import type { SupportedChatModel } from "@wincode/ai/models";
import { findSupportedChatModelSelection } from "@wincode/ai/models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
	resolveModelWithProvider,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "openai" }>;

export const openAIResolver = defineModelResolver(
	"openai",
	(model): model is Model => model.provider === "openai",
	{
		resolveWithApiKey: (model, apiKey, options) =>
			resolveModelWithProvider(model, createOpenAI({ apiKey }), options),
		resolveWithEnvironment: (model, options) =>
			resolveModelWithProvider(model, openai, options),
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
		...resolveModelWithProvider(supported, provider, options),
		model: provider.responses(supported.id),
	};
}
