import {
	type Provider,
	ProviderError,
	type ProviderModel,
	type ProviderModelDiscoveryContext,
} from "../sdk.ts";
import {
	createOpenAICompatibleProvider,
	type OpenAICompatibleFetch,
	type OpenAICompatibleFetchResponse,
	openAICompatibleApiKeyForAuthorization,
	openAICompatibleApiRootFor,
	openAICompatibleProtocolId,
	openAICompatibleResponseError,
} from "../sdk-private/openai-compatible.ts";

const OPENROUTER_PROVIDER_ID = "openrouter";
const OPENROUTER_MODELS_URL = "models";

type JsonRecord = Record<string, unknown>;

export type OpenRouterProviderOptions = Readonly<{
	baseUrl?: string;
	fetch?: OpenAICompatibleFetch;
}>;

const record = (value: unknown): JsonRecord | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;

const finiteNumber = (value: unknown): number | undefined => {
	const parsed = typeof value === "string" ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
		? parsed
		: undefined;
};

const positiveInteger = (value: unknown): number | undefined => {
	const parsed = finiteNumber(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: undefined;
};

const modelFromOpenRouter = (value: unknown): ProviderModel => {
	const data = record(value);
	if (typeof data?.id !== "string" || data.id.trim().length === 0) {
		throw new ProviderError(
			"provider",
			"OpenRouter returned a model without a valid ID."
		);
	}
	const topProvider = record(data.top_provider);
	const contextWindowTokens = positiveInteger(data.context_length);
	const maxOutputTokens = positiveInteger(topProvider?.max_completion_tokens);
	const pricing = record(data.pricing);
	const inputPrice = finiteNumber(pricing?.prompt);
	const outputPrice = finiteNumber(pricing?.completion);
	return {
		...(contextWindowTokens === undefined && maxOutputTokens === undefined
			? {}
			: {
					limits: {
						...(contextWindowTokens === undefined
							? {}
							: { contextWindowTokens }),
						...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
					},
				}),
		modelId: data.id,
		...(inputPrice === undefined && outputPrice === undefined
			? {}
			: {
					pricing: {
						...(inputPrice === undefined
							? {}
							: { inputPerMillionTokensUsd: inputPrice * 1_000_000 }),
						...(outputPrice === undefined
							? {}
							: { outputPerMillionTokensUsd: outputPrice * 1_000_000 }),
					},
				}),
		protocolId: openAICompatibleProtocolId,
		providerId: OPENROUTER_PROVIDER_ID,
	};
};

const discoveryResponse = async (
	apiRoot: URL,
	fetchImpl: OpenAICompatibleFetch,
	context: ProviderModelDiscoveryContext,
	apiKey: string
): Promise<OpenAICompatibleFetchResponse> => {
	try {
		return await fetchImpl(new URL(OPENROUTER_MODELS_URL, apiRoot), {
			headers: { authorization: `Bearer ${apiKey}` },
			method: "GET",
			signal: context.signal,
		});
	} catch (error) {
		if (context.signal?.aborted) {
			throw context.signal.reason ?? error;
		}
		throw new ProviderError(
			"transport",
			"OpenRouter model discovery request failed.",
			{ cause: error }
		);
	}
};

const payloadFromResponse = async (
	response: OpenAICompatibleFetchResponse,
	signal: AbortSignal | undefined
): Promise<unknown> => {
	try {
		const payload = await response.json();
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		return payload;
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		throw new ProviderError(
			"provider",
			"OpenRouter returned an invalid model list.",
			{ cause: error }
		);
	}
};

const modelsFromPayload = (payload: unknown): readonly ProviderModel[] => {
	const data = record(payload)?.data;
	if (!Array.isArray(data)) {
		throw new ProviderError(
			"provider",
			"OpenRouter returned an invalid model list."
		);
	}
	return data.map(modelFromOpenRouter);
};

const fetchOpenRouterModels =
	(apiRoot: URL, fetchImpl: OpenAICompatibleFetch) =>
	async (
		context: ProviderModelDiscoveryContext
	): Promise<readonly ProviderModel[]> => {
		const apiKey = openAICompatibleApiKeyForAuthorization(
			context.authorization,
			"OpenRouter"
		);
		const response = await discoveryResponse(
			apiRoot,
			fetchImpl,
			context,
			apiKey
		);
		if (context.signal?.aborted) {
			throw context.signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		if (!response.ok) {
			const error = await openAICompatibleResponseError(
				response,
				"OpenRouter",
				"model discovery"
			);
			if (context.signal?.aborted) {
				throw (
					context.signal.reason ?? new DOMException("Aborted", "AbortError")
				);
			}
			throw error;
		}
		return modelsFromPayload(
			await payloadFromResponse(response, context.signal)
		);
	};

export const createOpenRouterProvider = (
	options: OpenRouterProviderOptions = {}
): Provider => {
	const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1/";
	const apiRoot = openAICompatibleApiRootFor(baseUrl);
	const fetchImpl: OpenAICompatibleFetch =
		options.fetch ?? globalThis.fetch.bind(globalThis);
	return {
		...createOpenAICompatibleProvider({
			baseUrl,
			fetch: fetchImpl,
			models: [],
			providerId: OPENROUTER_PROVIDER_ID,
			providerName: "OpenRouter",
		}),
		discoverModels: fetchOpenRouterModels(apiRoot, fetchImpl),
	};
};
