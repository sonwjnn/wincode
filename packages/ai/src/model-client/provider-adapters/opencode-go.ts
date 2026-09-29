import type { OpenCodeGoProtocol } from "../../models";
import { anthropicStrategy } from "../protocols/anthropic";
import { openAIChatStrategy } from "../protocols/openai-chat";
import { openAIResponsesStrategy } from "../protocols/openai-responses";
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
			model: context.model,
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
			request: context.request,
		}
	);
};

const requestByCatalogProtocol = {
	openai: createResponsesRequest,
	anthropic: createAnthropicRequest,
	"openai-compatible": createChatRequest,
} satisfies Record<
	OpenCodeGoProtocol,
	(
		context: ProviderRequestContext
	) => ProviderRoute<ProviderProtocolById["opencode-go"]>
>;

const unsupportedProtocolRequest = (
	context: ProviderRequestContext,
	protocol: string
): never => {
	throw new Error(
		`Unsupported model route: ${context.request.target.providerId}/${protocol}`
	);
};

const createOpenCodeGoRequest = (context: ProviderRequestContext) => {
	if (context.model.provider !== "opencode-go") {
		throw new Error(
			`Unsupported model route: ${context.request.target.providerId}/${context.request.target.modelId}`
		);
	}
	const catalogProtocol =
		"protocol" in context.model ? context.model.protocol : undefined;
	const createRequest =
		catalogProtocol === undefined
			? createChatRequest
			: requestByCatalogProtocol[catalogProtocol];
	if (!createRequest) {
		return unsupportedProtocolRequest(
			context,
			catalogProtocol ?? DEFAULT_STRATEGY.protocol
		);
	}
	return createRequest(context);
};

export const openCodeGoAdapter = {
	defaultStrategy: DEFAULT_STRATEGY,
	createRequest: createOpenCodeGoRequest,
} satisfies ConnectionProviderAdapter<"opencode-go">;
