import { createOpenAI, openai } from "@ai-sdk/openai";
import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	normalizeModelVariant,
	type SupportedChatModel,
} from "../../models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "openai" }>;
const reasoningSummaryModels = new Set<Model["id"]>([
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);
const selection = (model: Model): ChatModelSelection => ({
	modelId: model.id,
	providerId: model.connectionProviderId,
});
const resolveVariantOrThrow = (
	model: Model,
	variant: ResolverOptions["variant"]
) => {
	if (
		variant !== undefined &&
		!normalizeModelVariant(selection(model), variant)
	) {
		throw new Error(`Unsupported model variant: openai/${model.id}/${variant}`);
	}
	return variant;
};
const options = (model: Model, variant?: ResolverOptions["variant"]) => ({
	openai: {
		store: false,
		...(reasoningSummaryModels.has(model.id)
			? { reasoningSummary: "detailed" }
			: {}),
		...(variant === undefined ? {} : { reasoningEffort: variant }),
	},
});
const resolve = (
	model: Model,
	provider: ReturnType<typeof createOpenAI>,
	variant?: ResolverOptions["variant"]
): ResolvedModel => ({
	model: provider(model.id),
	modelId: model.id,
	provider: "openai",
	providerOptions: options(model, variant),
});
export const openAIResolver = defineModelResolver(
	"openai",
	(model): model is Model => model.provider === "openai",
	{
		resolveWithApiKey: (model, apiKey, opts) =>
			resolve(
				model,
				createOpenAI({ apiKey }),
				resolveVariantOrThrow(model, opts.variant)
			),
		resolveWithEnvironment: (model, opts) =>
			resolve(model, openai, resolveVariantOrThrow(model, opts.variant)),
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
		...resolve(
			supported,
			provider,
			resolveVariantOrThrow(supported, options.variant)
		),
		model: provider.responses(supported.id),
	};
}
