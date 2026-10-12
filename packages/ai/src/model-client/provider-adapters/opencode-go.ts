import { withAnthropicModelMetadata } from "../../anthropic-model-metadata";
import { getModelMetadata } from "../../model-metadata-runtime";
import type { OpenCodeGoProtocol, SupportedChatModel } from "../../models";
import { anthropicStrategy } from "../protocols/anthropic";
import { openAIChatStrategy } from "../protocols/openai-chat";
import { openAIResponsesStrategy } from "../protocols/openai-responses";
import type { ModelProtocolStrategy } from "../protocols/types";
import { anthropicOptionsFor, openAIOptionsFor, requireApiKey } from "./shared";
import type {
	ConnectionProviderAdapter,
	ProviderProtocolById,
	ProviderRequestContext,
	ProviderRoute,
} from "./types";
import { providerRouteFor } from "./types";

const DEFAULT_STRATEGY = openAIChatStrategy;
const jsonHeaders = { "content-type": "application/json" } as const;

const createResponsesRequest = (context: ProviderRequestContext) => {
	const apiKey = requireApiKey(
		context,
		"OpenAI model target requires API-key or OAuth authorization."
	);
	return providerRouteFor(
		openAIResponsesStrategy,
		"https://opencode.ai/zen/go/v1/responses",
		{ ...jsonHeaders, authorization: `Bearer ${apiKey}` },
		{
			maxOutputTokens: context.maxOutputTokens,
			model: context.model,
			omitOutputTokenLimit: false,
			providerOptions: openAIOptionsFor(context.providerOptions),
			request: context.request,
		}
	);
};

const createAnthropicRequest = (context: ProviderRequestContext) => {
	const apiKey = requireApiKey(
		context,
		"Anthropic model target requires API-key authorization."
	);
	return providerRouteFor(
		anthropicStrategy,
		"https://opencode.ai/zen/go/v1/messages",
		{
			...jsonHeaders,
			"anthropic-version": "2023-06-01",
			"x-api-key": apiKey,
		},
		{
			maxOutputTokens: context.maxOutputTokens,
			model: withAnthropicModelMetadata(
				context.model,
				getModelMetadata(context.model)
			),
			providerOptions: anthropicOptionsFor(context.providerOptions),
			request: context.request,
		}
	);
};

const createChatRequest = (context: ProviderRequestContext) => {
	const apiKey = requireApiKey(
		context,
		"OpenCode Go model target requires API-key authorization."
	);
	return providerRouteFor(
		DEFAULT_STRATEGY,
		"https://opencode.ai/zen/go/v1/chat/completions",
		{ ...jsonHeaders, authorization: `Bearer ${apiKey}` },
		{
			maxOutputTokens: context.maxOutputTokens,
			model: context.model,
			request: context.request,
		}
	);
};

type OpenCodeGoProtocolRoute = Readonly<{
	createRequest: (
		context: ProviderRequestContext
	) => ProviderRoute<ProviderProtocolById["opencode-go"]>;
	strategy: ModelProtocolStrategy<ProviderProtocolById["opencode-go"]>;
}>;

const defaultRoute: OpenCodeGoProtocolRoute = {
	createRequest: createChatRequest,
	strategy: DEFAULT_STRATEGY,
};

const routeByCatalogProtocol = {
	openai: {
		createRequest: createResponsesRequest,
		strategy: openAIResponsesStrategy,
	},
	anthropic: {
		createRequest: createAnthropicRequest,
		strategy: anthropicStrategy,
	},
	"openai-compatible": defaultRoute,
} satisfies Record<OpenCodeGoProtocol, OpenCodeGoProtocolRoute>;

const routeForOpenCodeGoModel = (
	model: SupportedChatModel
): OpenCodeGoProtocolRoute => {
	if (model.provider !== "opencode-go") {
		throw new Error(
			`Unsupported model route: ${model.connectionProviderId}/${model.id}`
		);
	}
	const catalogProtocol = "protocol" in model ? model.protocol : undefined;
	if (catalogProtocol === undefined) {
		return defaultRoute;
	}
	const route = routeByCatalogProtocol[catalogProtocol];
	if (!route) {
		throw new Error(
			`Unsupported model route: ${model.connectionProviderId}/${catalogProtocol}`
		);
	}
	return route;
};

const strategyForOpenCodeGoModel = (
	model: SupportedChatModel
): ModelProtocolStrategy<ProviderProtocolById["opencode-go"]> =>
	routeForOpenCodeGoModel(model).strategy;

const createOpenCodeGoRequest = (context: ProviderRequestContext) =>
	routeForOpenCodeGoModel(context.model).createRequest(context);

export const openCodeGoAdapter = {
	defaultStrategy: DEFAULT_STRATEGY,
	strategyForModel: strategyForOpenCodeGoModel,
	createRequest: createOpenCodeGoRequest,
} satisfies ConnectionProviderAdapter<"opencode-go">;
