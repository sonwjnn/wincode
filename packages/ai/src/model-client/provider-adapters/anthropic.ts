import { anthropicStrategy } from "../protocols/anthropic";
import { anthropicOptionsFor, requireApiKey } from "./shared";
import type { ConnectionProviderAdapter } from "./types";
import { type ProviderRequestContext, providerRouteFor } from "./types";

const DEFAULT_STRATEGY = anthropicStrategy;

const createAnthropicRequest = (context: ProviderRequestContext) => {
	const apiKey = requireApiKey(
		context,
		"Anthropic model target requires API-key authorization."
	);
	return providerRouteFor(
		DEFAULT_STRATEGY,
		"https://api.anthropic.com/v1/messages",
		{
			"content-type": "application/json",
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

export const anthropicAdapter = {
	defaultStrategy: DEFAULT_STRATEGY,
	createRequest: createAnthropicRequest,
} satisfies ConnectionProviderAdapter<"anthropic">;
