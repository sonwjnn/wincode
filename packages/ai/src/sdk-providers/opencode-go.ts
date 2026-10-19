import type { JsonObject } from "type-fest";
import { apiKeyCredentialSchema } from "../credential-schemas.ts";
import { providerModels as openCodeGoProviderModels } from "../generated/opencode-go.generated.ts";
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
import {
	httpErrorFromResponse,
	ProviderProtocolError,
} from "../sdk-private/protocol-errors.ts";
import { createAnthropicStrategy } from "../sdk-private/protocols/anthropic.ts";
import { openAIChatStrategy } from "../sdk-private/protocols/openai-chat.ts";
import { openAIResponsesStrategy } from "../sdk-private/protocols/openai-responses.ts";
import {
	type AnthropicProtocolOptions,
	type OpenAIProtocolOptions,
	openAIProtocolReasoningEffortFor,
} from "../sdk-private/protocols/provider-options.ts";
import type {
	ProtocolPromptMessage,
	ProtocolPromptPart,
	ProtocolTool,
	ProviderProtocolRequest,
} from "../sdk-private/protocols/request.ts";
import { unreachableValue } from "../sdk-private/protocols/shared.ts";
import type { ModelProtocolStrategy } from "../sdk-private/protocols/types.ts";

const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const openCodeGoAnthropicStrategy = createAnthropicStrategy();
const RESPONSES_PROTOCOL_ID = "openai-responses";
const ANTHROPIC_PROTOCOL_ID = "anthropic";
const OPENAI_COMPATIBLE_PROTOCOL_ID = "openai-compatible";
const RESPONSES_URL = "https://opencode.ai/zen/go/v1/responses";
const MESSAGES_URL = "https://opencode.ai/zen/go/v1/messages";
const CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const JSON_HEADERS = { "content-type": "application/json" } as const;

type OpenCodeGoProtocolId =
	| typeof RESPONSES_PROTOCOL_ID
	| typeof ANTHROPIC_PROTOCOL_ID
	| typeof OPENAI_COMPATIBLE_PROTOCOL_ID;

export type OpenCodeGoFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export type OpenCodeGoProviderOptions = Readonly<{
	fetch?: OpenCodeGoFetch;
	models?: readonly ProviderModel[];
	/** Stable across requests for one conversation; defaults to a generated ID. */
	sessionId?: string;
}>;

const promptPart = (part: ChatContentPart): ProtocolPromptPart => {
	switch (part.type) {
		case "text":
			return part;
		case "file":
		case "image":
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

const promptMessages = (
	messages: ProviderChatRequest["messages"]
): readonly ProtocolPromptMessage[] =>
	messages.map((message) => ({
		...(message.role === "assistant" && message.continuation !== undefined
			? { continuation: message.continuation }
			: {}),
		content: message.content.map(promptPart),
		role: message.role,
	}));

const modelTools = (
	tools: ProviderChatRequest["tools"]
): readonly ProtocolTool[] | undefined =>
	tools?.map((tool) => ({
		description: tool.description ?? "",
		inputSchema: tool.inputSchema as JsonObject,
		name: tool.name,
	}));

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
		messages: promptMessages(request.messages),
		modelId: context.model.modelId,
		...(request.promptCacheKey === undefined
			? {}
			: { promptCacheKey: request.promptCacheKey }),
		signal: context.signal,
		system: request.system,
		tools: modelTools(request.tools),
	};
};

type OpenCodeGoWireRequest = Readonly<{
	body: Record<string, unknown>;
	headers: Readonly<Record<string, string>>;
	strategy: ModelProtocolStrategy;
	url: string;
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

const openAIProviderOptionsFor = (
	reasoningEffort: ProviderProtocolRequest["reasoningEffort"]
): OpenAIProtocolOptions | undefined =>
	reasoningEffort === undefined
		? undefined
		: { reasoningEffort: openAIProtocolReasoningEffortFor(reasoningEffort) };

const wireRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	apiKey: string,
	sessionId: string
): OpenCodeGoWireRequest => {
	const model = context.model;
	const modelRequest = modelRequestFor(request, context);
	const requestedMaxOutputTokens = maxOutputTokensForRequest(
		request.maxOutputTokens,
		context.model
	);
	const maxOutputTokens = request.cacheWarming ? 1 : requestedMaxOutputTokens;
	const protocolId = context.model.protocolId as OpenCodeGoProtocolId;
	if (protocolId === RESPONSES_PROTOCOL_ID) {
		return {
			body: openAIResponsesStrategy.serialize({
				maxOutputTokens,
				model,
				omitOutputTokenLimit: false,
				providerOptions: openAIProviderOptionsFor(modelRequest.reasoningEffort),
				request: modelRequest,
			}),
			headers: {
				...JSON_HEADERS,
				authorization: `Bearer ${apiKey}`,
				"x-opencode-session": sessionId,
			},
			strategy: openAIResponsesStrategy,
			url: RESPONSES_URL,
		};
	}
	if (protocolId === ANTHROPIC_PROTOCOL_ID) {
		return {
			body: openCodeGoAnthropicStrategy.serialize({
				maxOutputTokens,
				model,
				providerOptions: anthropicProviderOptionsFor(
					modelRequest.reasoningEffort
				),
				request: modelRequest,
			}),
			headers: {
				...JSON_HEADERS,
				"anthropic-version": "2023-06-01",
				"x-api-key": apiKey,
				"x-opencode-session": sessionId,
			},
			strategy: openCodeGoAnthropicStrategy,
			url: MESSAGES_URL,
		};
	}
	return {
		body: openAIChatStrategy.serialize({
			maxOutputTokens,
			model,
			request: modelRequest,
		}),
		headers: {
			...JSON_HEADERS,
			authorization: `Bearer ${apiKey}`,
			"x-opencode-session": sessionId,
		},
		strategy: openAIChatStrategy,
		url: CHAT_COMPLETIONS_URL,
	};
};

const apiKeyFor = (value: unknown): string => {
	if (
		typeof value === "object" &&
		value !== null &&
		"apiKey" in value &&
		typeof value.apiKey === "string" &&
		value.apiKey.length > 0
	) {
		return value.apiKey;
	}
	throw new ProviderError(
		"authentication",
		"OpenCode Go authorization is invalid."
	);
};

const providerErrorFor = (error: unknown): ProviderError => {
	if (error instanceof ProviderError) {
		return error;
	}
	if (error instanceof ProviderProtocolError) {
		if (error.statusCode === 401 || error.statusCode === 403) {
			return new ProviderError(
				"authentication",
				"OpenCode Go rejected the configured credential.",
				{ cause: error }
			);
		}
		return new ProviderError(
			"provider",
			error.statusCode === undefined
				? "OpenCode Go returned an invalid or incomplete stream."
				: `OpenCode Go request failed (${error.statusCode}).`,
			{ cause: error }
		);
	}
	return new ProviderError("transport", "OpenCode Go network request failed.", {
		cause: error,
	});
};

const fetchOpenCodeGoResponse = async (
	wireRequest: OpenCodeGoWireRequest,
	fetchImpl: OpenCodeGoFetch,
	signal: AbortSignal | undefined
): Promise<Response> => {
	let response: Response;
	try {
		response = await fetchImpl(wireRequest.url, {
			body: JSON.stringify(wireRequest.body),
			headers: wireRequest.headers,
			method: "POST",
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		throw new ProviderError(
			"transport",
			"OpenCode Go network request failed.",
			{
				cause: error,
			}
		);
	}
	if (!response.ok) {
		throw await httpErrorFromResponse(response);
	}
	return response;
};

const streamOpenCodeGoResponse = async function* (
	wireRequest: OpenCodeGoWireRequest,
	response: Response,
	signal: AbortSignal | undefined
): AsyncIterable<ProviderChatEvent> {
	for await (const part of wireRequest.strategy.stream(response, signal)) {
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}
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

const streamOpenCodeGo = (fetchImpl: OpenCodeGoFetch, sessionId: string) =>
	async function* (
		request: ProviderChatRequest,
		context: ProviderChatContext
	): AsyncIterable<ProviderChatEvent> {
		try {
			const apiKey = apiKeyFor(context.authorization);
			const wireRequest = wireRequestFor(request, context, apiKey, sessionId);
			const response = await fetchOpenCodeGoResponse(
				wireRequest,
				fetchImpl,
				context.signal
			);
			yield* streamOpenCodeGoResponse(wireRequest, response, context.signal);
		} catch (error) {
			if (context.signal?.aborted) {
				throw context.signal.reason ?? error;
			}
			throw providerErrorFor(error);
		}
	};

/** Creates OpenCode Go without merging its identity with route providers. */
export const createOpenCodeGoProvider = (
	options: OpenCodeGoProviderOptions = {}
): Provider => {
	const fetchImpl: OpenCodeGoFetch =
		options.fetch ?? globalThis.fetch.bind(globalThis);
	const sessionId = options.sessionId ?? globalThis.crypto.randomUUID();
	const models: readonly ProviderModel[] =
		options.models ??
		openCodeGoProviderModels.map((model: ProviderModel) =>
			model.protocolId !== ANTHROPIC_PROTOCOL_ID ||
			model.reasoningEfforts === undefined
				? model
				: {
						...model,
						reasoningEfforts: model.reasoningEfforts.filter(
							(effort) => effort !== "minimal"
						),
					}
		);
	if (
		models.some(
			(model) =>
				model.providerId !== OPENCODE_GO_PROVIDER_ID ||
				![
					RESPONSES_PROTOCOL_ID,
					ANTHROPIC_PROTOCOL_ID,
					OPENAI_COMPATIBLE_PROTOCOL_ID,
				].includes(model.protocolId)
		)
	) {
		throw new Error(
			"OpenCode Go models must use provider ID opencode-go and a supported protocol ID."
		);
	}
	return {
		id: OPENCODE_GO_PROVIDER_ID,
		models,
		resolveAuthorization: async ({ credential }) => {
			const parsed = apiKeyCredentialSchema.safeParse(credential);
			return parsed.success
				? { authorization: { apiKey: parsed.data.apiKey } }
				: null;
		},
		streamChat: streamOpenCodeGo(fetchImpl, sessionId),
	};
};
