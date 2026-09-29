import { googleStrategy } from "../protocols/google";
import { googleOptionsFor, requireApiKey } from "./shared";
import type { ConnectionProviderAdapter } from "./types";
import { type ProviderRequestContext, providerRouteFor } from "./types";

const DEFAULT_STRATEGY = googleStrategy;

const createGoogleRequest = (context: ProviderRequestContext) => {
	const apiKey = requireApiKey(
		context,
		"Google model target requires API-key authorization."
	);
	const { modelId } = context.request.target;
	return providerRouteFor(
		DEFAULT_STRATEGY,
		`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`,
		{ "content-type": "application/json", "x-goog-api-key": apiKey },
		{
			maxOutputTokens: context.maxOutputTokens,
			providerOptions: googleOptionsFor(context.providerOptions),
			request: context.request,
		}
	);
};

export const googleAdapter = {
	defaultStrategy: DEFAULT_STRATEGY,
	createRequest: createGoogleRequest,
} satisfies ConnectionProviderAdapter<"google">;
