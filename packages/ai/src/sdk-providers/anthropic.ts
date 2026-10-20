import type { JsonObject } from "type-fest";
import { apiKeyCredentialSchema } from "../credential-schemas.ts";
import { providerModels as anthropicProviderModels } from "../generated/anthropic.generated.ts";
import {
	type ChatContentPart,
	maxOutputTokensForRequest,
	type Provider,
	type ProviderChatContext,
	type ProviderChatEvent,
	type ProviderChatHeaderContext,
	type ProviderChatRequest,
	ProviderError,
	type ProviderModel,
} from "../sdk.ts";
import {
	httpErrorFromResponse,
	isCacheControlRejection,
	ProviderProtocolError,
} from "../sdk-private/protocol-errors.ts";
import { anthropicStrategy } from "../sdk-private/protocols/anthropic-default.ts";
import type { AnthropicProtocolOptions } from "../sdk-private/protocols/provider-options.ts";
import type {
	ProtocolPromptMessage,
	ProtocolPromptPart,
	ProtocolTool,
	ProviderProtocolRequest,
} from "../sdk-private/protocols/request.ts";
import { unreachableValue } from "../sdk-private/protocols/shared.ts";

const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_PROTOCOL_ID = "anthropic";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODELS: readonly ProviderModel[] = anthropicProviderModels.map(
	(model: ProviderModel) =>
		model.reasoningEfforts === undefined
			? model
			: {
					...model,
					reasoningEfforts: model.reasoningEfforts.filter(
						(effort) => effort !== "minimal"
					),
				}
);

type AnthropicAuthorization = Readonly<{ apiKey: string }>;

export type AnthropicFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export type AnthropicProviderOptions = Readonly<{
	fetch?: AnthropicFetch;
	models?: readonly ProviderModel[];
}>;

const promptPart = (part: ChatContentPart): ProtocolPromptPart => {
	switch (part.type) {
		case "text":
			return part;
		case "image":
		case "file":
			return { data: part.data, mediaType: part.mediaType, type: "file" };
		case "tool-call":
			return part;
		case "tool-result":
		case "tool-failure":
			return part;
		default:
			return unreachableValue(part);
	}
};

const promptMessage = (
	message: ProviderChatRequest["messages"][number]
): ProtocolPromptMessage => ({
	...(message.role === "assistant" && message.continuation !== undefined
		? { continuation: message.continuation }
		: {}),
	content: message.content.map(promptPart),
	role: message.role,
});

const modelRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext
): ProviderProtocolRequest => {
	const reasoningEffort =
		!request.cacheWarming &&
		request.reasoningEffort !== undefined &&
		context.model.reasoningEfforts?.includes(request.reasoningEffort)
			? request.reasoningEffort
			: undefined;
	return {
		...(request.cacheWarming === true ? { cacheWarming: true } : {}),
		...(request.cacheRetention !== undefined ||
		request.promptCacheKey !== undefined
			? { promptCacheEnabled: true }
			: {}),
		...(request.cacheRetention === undefined
			? {}
			: { promptCacheRetention: request.cacheRetention }),
		...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		messages: request.messages.map(promptMessage),
		modelId: context.model.modelId,
		...(request.promptCacheKey === undefined
			? {}
			: { promptCacheKey: request.promptCacheKey }),
		signal: context.signal,
		system: request.system,
		tools: request.tools?.map(
			(tool) =>
				({
					...(tool.description === undefined
						? {}
						: { description: tool.description }),
					inputSchema: tool.inputSchema as JsonObject,
					name: tool.name,
				}) as ProtocolTool
		),
	};
};

const parseAuthorization = (value: unknown): AnthropicAuthorization => {
	const authorization =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: undefined;
	const apiKey = authorization?.apiKey;
	if (typeof apiKey === "string" && apiKey.length > 0) {
		return { apiKey };
	}
	throw new ProviderError(
		"authentication",
		"Anthropic authorization is invalid."
	);
};

const anthropicChatHeadersFor = (
	context: ProviderChatHeaderContext
): Readonly<Record<string, string>> => {
	const authorization = parseAuthorization(context.authorization);
	return {
		"anthropic-version": "2023-06-01",
		"content-type": "application/json",
		"x-api-key": authorization.apiKey,
	};
};

const providerErrorFor = (error: unknown): ProviderError => {
	if (error instanceof ProviderError) {
		return error;
	}
	if (error instanceof ProviderProtocolError) {
		if (error.statusCode === 401 || error.statusCode === 403) {
			return new ProviderError(
				"authentication",
				"Anthropic rejected the configured credential.",
				{ cause: error }
			);
		}
		return new ProviderError(
			"provider",
			error.statusCode === undefined
				? "Anthropic returned an invalid or incomplete stream."
				: `Anthropic request failed (${error.statusCode}).`,
			{ cause: error }
		);
	}
	return new ProviderError("transport", "Anthropic network request failed.", {
		cause: error,
	});
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

type AnthropicWireRequest = Readonly<{
	body: string;
	hasCacheControls: boolean;
}>;

const anthropicProviderOptionsFor = (
	reasoningEffort: ProviderProtocolRequest["reasoningEffort"]
): AnthropicProtocolOptions | undefined => {
	if (reasoningEffort === undefined) {
		return;
	}
	if (reasoningEffort === "off") {
		return { thinking: { type: "disabled" } };
	}
	if (reasoningEffort === "minimal") {
		return;
	}
	return { effort: reasoningEffort };
};

const wireRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	model: ProviderModel,
	cacheRetention: ProviderChatRequest["cacheRetention"]
): AnthropicWireRequest => {
	const requestWithCache = { ...request, cacheRetention };
	const modelRequest = modelRequestFor(requestWithCache, context);
	const requestedMaxOutputTokens = maxOutputTokensForRequest(
		request.maxOutputTokens,
		context.model
	);
	const maxOutputTokens = request.cacheWarming
		? 1
		: (requestedMaxOutputTokens ??
			maxOutputTokensForRequest(
				context.model.limits?.maxOutputTokens,
				context.model
			));
	const body = anthropicStrategy.serialize({
		maxOutputTokens,
		model,
		providerOptions: anthropicProviderOptionsFor(modelRequest.reasoningEffort),
		request: modelRequest,
	});
	return {
		body: JSON.stringify(body),
		hasCacheControls:
			cacheRetention !== undefined &&
			anthropicStrategy.promptCache.routeForModel(model)?.hasControls === true,
	};
};

const streamWireRequest = async function* (
	wireRequest: AnthropicWireRequest,
	headers: Readonly<Record<string, string>>,
	fetchImpl: AnthropicFetch,
	signal?: AbortSignal
): AsyncIterable<ProviderChatEvent> {
	let response: Response;
	try {
		response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
			body: wireRequest.body,
			headers,
			method: "POST",
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		throw new ProviderError("transport", "Anthropic network request failed.", {
			cause: error,
		});
	}
	if (!response.ok) {
		throw await httpErrorFromResponse(response);
	}
	throwIfAborted(signal);
	for await (const part of anthropicStrategy.stream(response, signal)) {
		throwIfAborted(signal);
		if (part.type === "finish") {
			if (part.usage) {
				yield { type: "usage", usage: part.usage };
			}
			yield {
				...(part.continuation === undefined
					? {}
					: { continuation: part.continuation }),
				type: "finish",
			};
		} else {
			yield part;
		}
	}
};

const streamWithCacheFallback = async function* (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	model: ProviderModel,
	fetchImpl: AnthropicFetch,
	cachedRequest: AnthropicWireRequest
): AsyncIterable<ProviderChatEvent> {
	let outputStarted = false;
	try {
		for await (const event of streamWireRequest(
			cachedRequest,
			context.headers,
			fetchImpl,
			context.signal
		)) {
			if (event.type !== "finish") {
				outputStarted = true;
			}
			yield event;
		}
	} catch (error) {
		if (
			request.cacheWarming ||
			outputStarted ||
			!cachedRequest.hasCacheControls ||
			!isCacheControlRejection(error) ||
			context.signal?.aborted
		) {
			throw error;
		}
		const uncachedRequest = wireRequestFor(request, context, model, undefined);
		yield* streamWireRequest(
			uncachedRequest,
			context.headers,
			fetchImpl,
			context.signal
		);
	}
};

const streamAnthropic = (fetchImpl: AnthropicFetch) =>
	async function* (
		request: ProviderChatRequest,
		context: ProviderChatContext
	): AsyncIterable<ProviderChatEvent> {
		try {
			const model = context.model;
			const cachedRequest = wireRequestFor(
				request,
				context,
				model,
				request.cacheRetention
			);
			yield* streamWithCacheFallback(
				request,
				context,
				model,
				fetchImpl,
				cachedRequest
			);
		} catch (error) {
			if (context.signal?.aborted) {
				throw context.signal.reason ?? error;
			}
			throw providerErrorFor(error);
		}
	};

export const createAnthropicProvider = (
	options: AnthropicProviderOptions = {}
): Provider => {
	const fetchImpl: AnthropicFetch =
		options.fetch ?? globalThis.fetch.bind(globalThis);
	const models = options.models ?? DEFAULT_MODELS;
	if (
		models.some(
			(model) =>
				model.providerId !== ANTHROPIC_PROVIDER_ID ||
				model.protocolId !== ANTHROPIC_PROTOCOL_ID
		)
	) {
		throw new Error(
			"Anthropic provider models must use provider ID and protocol ID anthropic."
		);
	}
	return {
		id: ANTHROPIC_PROVIDER_ID,
		models,
		resolveAuthorization: async ({ credential }) => {
			const parsedCredential = apiKeyCredentialSchema.safeParse(credential);
			return parsedCredential.success
				? {
						authorization: { apiKey: parsedCredential.data.apiKey },
					}
				: null;
		},
		getChatHeaders: anthropicChatHeadersFor,
		streamChat: streamAnthropic(fetchImpl),
	};
};
