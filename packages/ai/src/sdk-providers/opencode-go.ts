import type { JsonObject } from "type-fest";
import { apiKeyCredentialSchema } from "../connections/credential-schemas.ts";
import { openCodeGoModelMetadataById } from "../generated/opencode-go-model-metadata.generated.ts";
import { openCodeGoSdkModels } from "../generated/opencode-go-sdk-models.generated.ts";
import {
	httpErrorFromResponse,
	ModelProviderError,
} from "../model-client/errors.ts";
import { createAnthropicStrategy } from "../model-client/protocols/anthropic.ts";
import { openAIChatStrategy } from "../model-client/protocols/openai-chat.ts";
import { openAIResponsesStrategy } from "../model-client/protocols/openai-responses.ts";
import { unreachableValue } from "../model-client/protocols/shared.ts";
import type { ModelProtocolStrategy } from "../model-client/protocols/types.ts";
import type {
	ModelPromptMessage,
	ModelPromptPart,
	ModelStepRequest,
	ModelTool,
} from "../model-client/types.ts";
import type {
	AnthropicProviderOptions,
	OpenAIProviderOptions,
} from "../model-provider-options.ts";
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

const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const openCodeGoAnthropicStrategy = createAnthropicStrategy(
	(model) => openCodeGoModelMetadataById[model.id]
);
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
}>;

const openCodeGoProtocolForModel = (
	model: ProviderModel
): SupportedChatModel => {
	let protocol: "openai" | "anthropic" | "openai-compatible";
	if (model.protocolId === RESPONSES_PROTOCOL_ID) {
		protocol = "openai";
	} else if (model.protocolId === ANTHROPIC_PROTOCOL_ID) {
		protocol = "anthropic";
	} else {
		protocol = "openai-compatible";
	}
	return {
		connectionProviderId: OPENCODE_GO_PROVIDER_ID,
		displayName: model.modelId,
		id: model.modelId,
		lifecycle: "active",
		protocol,
		provider: OPENCODE_GO_PROVIDER_ID,
		route: "direct",
	} as SupportedChatModel;
};

const promptPart = (part: ChatContentPart): ModelPromptPart => {
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
): readonly ModelPromptMessage[] =>
	messages.map((message) => ({
		...(message.role === "assistant" && message.continuation !== undefined
			? { continuation: message.continuation }
			: {}),
		content: message.content.map(promptPart),
		role: message.role,
	}));

const modelTools = (
	tools: ProviderChatRequest["tools"]
): readonly ModelTool[] | undefined =>
	tools?.map((tool) => ({
		description: tool.description ?? "",
		inputSchema: tool.inputSchema as JsonObject,
		name: tool.name,
	}));

const modelTargetFor = (
	modelId: string,
	apiKey: string,
	cacheRetention: ProviderChatRequest["cacheRetention"]
): ModelTarget =>
	({
		authorization: { apiKey, kind: "api-key" },
		...(cacheRetention === undefined
			? {}
			: {
					promptCacheEnabled: true,
					promptCacheRetention: cacheRetention,
				}),
		modelId,
		providerId: OPENCODE_GO_PROVIDER_ID,
	}) as ModelTarget;

const modelRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	apiKey: string
): ModelStepRequest => {
	const reasoningEffort =
		!request.cacheWarming &&
		request.reasoningEffort !== undefined &&
		context.model.reasoningEfforts?.includes(request.reasoningEffort)
			? request.reasoningEffort
			: undefined;
	return {
		...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		messages: promptMessages(request.messages),
		signal: context.signal,
		system: request.system,
		target: modelTargetFor(
			context.model.modelId,
			apiKey,
			request.cacheRetention
		),
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
	reasoningEffort: ModelStepRequest["reasoningEffort"]
): AnthropicProviderOptions["anthropic"] | undefined => {
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

const openAIProviderOptionsFor = (
	reasoningEffort: ModelStepRequest["reasoningEffort"]
): OpenAIProviderOptions["openai"] | undefined =>
	reasoningEffort === undefined ? undefined : { reasoningEffort };

const wireRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	apiKey: string
): OpenCodeGoWireRequest => {
	const model = openCodeGoProtocolForModel(context.model);
	const modelRequest = modelRequestFor(request, context, apiKey);
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
	if (error instanceof ModelProviderError) {
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

const streamOpenCodeGo = (fetchImpl: OpenCodeGoFetch) =>
	async function* (
		request: ProviderChatRequest,
		context: ProviderChatContext
	): AsyncIterable<ProviderChatEvent> {
		try {
			const apiKey = apiKeyFor(context.authorization);
			const wireRequest = wireRequestFor(request, context, apiKey);
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
	const models =
		options.models ??
		openCodeGoSdkModels.map((model) => {
			const enriched = withProviderModelMetadata(
				model,
				openCodeGoModelMetadataById[model.modelId]
			);
			return enriched.protocolId !== ANTHROPIC_PROTOCOL_ID ||
				enriched.reasoningEfforts === undefined
				? enriched
				: {
						...enriched,
						reasoningEfforts: enriched.reasoningEfforts.filter(
							(effort) => effort !== "minimal"
						),
					};
		});
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
		streamChat: streamOpenCodeGo(fetchImpl),
	};
};
