import type { JsonObject } from "type-fest";
import { apiKeyCredentialSchema } from "../connections/credential-schemas.ts";
import { anthropicModelMetadataById } from "../generated/anthropic-model-metadata.generated.ts";
import {
	httpErrorFromResponse,
	isCacheControlRejection,
	ModelProviderError,
} from "../model-client/errors.ts";
import { anthropicStrategy } from "../model-client/protocols/anthropic-default.ts";
import { unreachableValue } from "../model-client/protocols/shared.ts";
import type {
	ModelPromptMessage,
	ModelPromptPart,
	ModelStepRequest,
	ModelTool,
} from "../model-client/types.ts";
import type { AnthropicProviderOptions as AnthropicModelProtocolOptions } from "../model-provider-options.ts";
import type { ModelTarget } from "../model-target.ts";
import type { SupportedChatModel } from "../models.ts";
import { withProviderModelMetadata } from "../provider-model-metadata.ts";
import {
	type ChatContentPart,
	maxOutputTokensForRequest,
	type Provider,
	type ProviderChatContext,
	type ProviderChatEvent,
	type ProviderChatRequest,
	ProviderError,
	type ProviderModel,
} from "../sdk.ts";

const ANTHROPIC_PROVIDER_ID = "anthropic";
const ANTHROPIC_PROTOCOL_ID = "anthropic";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODELS = [
	"claude-opus-5.5",
	"claude-opus-4-5",
	"claude-opus-4-5-20251101",
	"claude-opus-4-7",
	"claude-sonnet-5",
	"claude-opus-4-8",
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
	"claude-haiku-4-5-20251001",
	"claude-sonnet-4-5",
	"claude-sonnet-4-5-20250929",
].map((modelId): ProviderModel => {
	const model = withProviderModelMetadata(
		{
			modelId,
			protocolId: ANTHROPIC_PROTOCOL_ID,
			providerId: ANTHROPIC_PROVIDER_ID,
		},
		anthropicModelMetadataById[modelId]
	);
	return model.reasoningEfforts === undefined
		? model
		: {
				...model,
				reasoningEfforts: model.reasoningEfforts.filter(
					(effort) => effort !== "minimal"
				),
			};
});

type AnthropicAuthorization = Readonly<{ apiKey: string }>;

export type AnthropicFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export type AnthropicProviderOptions = Readonly<{
	fetch?: AnthropicFetch;
	models?: readonly ProviderModel[];
}>;

const modelForProtocol = (model: ProviderModel): SupportedChatModel =>
	({
		connectionProviderId: ANTHROPIC_PROVIDER_ID,
		displayName: model.modelId,
		id: model.modelId as SupportedChatModel["id"],
		lifecycle: "active",
		provider: ANTHROPIC_PROVIDER_ID,
		route: "direct",
	}) as SupportedChatModel;

const promptPart = (part: ChatContentPart): ModelPromptPart => {
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
): ModelPromptMessage => ({
	...(message.role === "assistant" && message.continuation !== undefined
		? { continuation: message.continuation }
		: {}),
	content: message.content.map(promptPart),
	role: message.role,
});

const modelRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	authorization: AnthropicAuthorization
): ModelStepRequest => {
	const reasoningEffort =
		!request.cacheWarming &&
		request.reasoningEffort !== undefined &&
		context.model.reasoningEfforts?.includes(request.reasoningEffort)
			? request.reasoningEffort
			: undefined;
	const target: ModelTarget = {
		authorization: { apiKey: authorization.apiKey, kind: "api-key" },
		...(request.cacheRetention === undefined
			? {}
			: {
					promptCacheEnabled: true as const,
					promptCacheRetention: request.cacheRetention,
				}),
		modelId: context.model.modelId as Extract<
			ModelTarget,
			{ providerId: "anthropic" }
		>["modelId"],
		providerId: ANTHROPIC_PROVIDER_ID,
	};
	return {
		...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		messages: request.messages.map(promptMessage),
		signal: context.signal,
		system: request.system,
		target,
		tools: request.tools?.map(
			(tool) =>
				({
					...(tool.description === undefined
						? {}
						: { description: tool.description }),
					inputSchema: tool.inputSchema as JsonObject,
					name: tool.name,
				}) as ModelTool
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

const providerErrorFor = (error: unknown): ProviderError => {
	if (error instanceof ProviderError) {
		return error;
	}
	if (error instanceof ModelProviderError) {
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
	reasoningEffort: ModelStepRequest["reasoningEffort"]
): AnthropicModelProtocolOptions["anthropic"] | undefined => {
	if (reasoningEffort === undefined) {
		return;
	}
	if (reasoningEffort === "none") {
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
	authorization: AnthropicAuthorization,
	model: SupportedChatModel,
	cacheRetention: ProviderChatRequest["cacheRetention"]
): AnthropicWireRequest => {
	const requestWithCache = { ...request, cacheRetention };
	const modelRequest = modelRequestFor(
		requestWithCache,
		context,
		authorization
	);
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
	authorization: AnthropicAuthorization,
	fetchImpl: AnthropicFetch,
	signal?: AbortSignal
): AsyncIterable<ProviderChatEvent> {
	let response: Response;
	try {
		response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
			body: wireRequest.body,
			headers: {
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
				"x-api-key": authorization.apiKey,
			},
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
	authorization: AnthropicAuthorization,
	model: SupportedChatModel,
	fetchImpl: AnthropicFetch,
	cachedRequest: AnthropicWireRequest
): AsyncIterable<ProviderChatEvent> {
	let outputStarted = false;
	try {
		for await (const event of streamWireRequest(
			cachedRequest,
			authorization,
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
		const uncachedRequest = wireRequestFor(
			request,
			context,
			authorization,
			model,
			undefined
		);
		yield* streamWireRequest(
			uncachedRequest,
			authorization,
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
			const authorization = parseAuthorization(context.authorization);
			const model = modelForProtocol(context.model);
			const cachedRequest = wireRequestFor(
				request,
				context,
				authorization,
				model,
				request.cacheRetention
			);
			yield* streamWithCacheFallback(
				request,
				context,
				authorization,
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
		streamChat: streamAnthropic(fetchImpl),
	};
};
