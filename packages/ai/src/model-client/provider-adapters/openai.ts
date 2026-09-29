import { openAIResponsesStrategy } from "../protocols/openai-responses";
import { openAIOptionsFor, requireApiKey } from "./shared";
import type { ConnectionProviderAdapter } from "./types";
import { type ProviderRequestContext, providerRouteFor } from "./types";

const DEFAULT_STRATEGY = openAIResponsesStrategy;

const jsonHeaders = { "content-type": "application/json" } as const;

const createOpenAIRequest = (context: ProviderRequestContext) => {
	const authorization = context.request.target.authorization;
	const bodyContext = {
		maxOutputTokens: context.maxOutputTokens,
		omitOutputTokenLimit: authorization.kind === "oauth",
		providerOptions: openAIOptionsFor(context.providerOptions),
		request: context.request,
	};
	if (authorization.kind === "oauth") {
		return providerRouteFor(
			DEFAULT_STRATEGY,
			"https://chatgpt.com/backend-api/codex/responses",
			{
				...jsonHeaders,
				authorization: `Bearer ${authorization.accessToken}`,
				"chatgpt-account-id": authorization.accountId,
				"openai-beta": "responses=experimental",
				originator: "wincode",
			},
			bodyContext
		);
	}
	const apiKey = requireApiKey(
		context,
		"OpenAI model target requires API-key or OAuth authorization."
	);
	return providerRouteFor(
		DEFAULT_STRATEGY,
		"https://api.openai.com/v1/responses",
		{ ...jsonHeaders, authorization: `Bearer ${apiKey}` },
		bodyContext
	);
};

export const openAIAdapter = {
	defaultStrategy: DEFAULT_STRATEGY,
	createRequest: createOpenAIRequest,
} satisfies ConnectionProviderAdapter<"openai">;
