import { apiKeyCredentialSchema } from "../credential-schemas.ts";
import {
	maxOutputTokensForRequest,
	type Provider,
	type ProviderChatContext,
	type ProviderChatEvent,
	type ProviderChatHeaderContext,
	type ProviderChatRequest,
	ProviderError,
	type ProviderModel,
} from "../sdk.ts";
import { ProviderProtocolError } from "./protocol-errors.ts";
import { openAICompatibleChatProtocol } from "./protocols/openai-chat.ts";
import type {
	ProtocolPromptMessage,
	ProtocolPromptPart,
	ProtocolStreamPart,
} from "./protocols/request.ts";
import { unreachableValue } from "./protocols/shared.ts";

const OPENAI_COMPATIBLE_PROTOCOL_ID = "openai-compatible";
const TRAILING_SLASHES = /\/+$/u;

export type OpenAICompatibleFetchResponse = Readonly<{
	body: ReadableStream<Uint8Array> | null;
	headers: Readonly<{ get: (name: string) => string | null }>;
	json: () => Promise<unknown>;
	ok: boolean;
	status: number;
}>;

export type OpenAICompatibleFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<OpenAICompatibleFetchResponse>;

type OpenAICompatibleProviderOptions = Readonly<{
	baseUrl: string;
	fetch?: OpenAICompatibleFetch;
	models: readonly ProviderModel[];
	providerId: string;
	providerName: string;
}>;

const apiRootFor = (baseUrl: string): URL => {
	const apiRoot = new URL(baseUrl);
	apiRoot.pathname = `${apiRoot.pathname.replace(TRAILING_SLASHES, "")}/`;
	apiRoot.search = "";
	apiRoot.hash = "";
	return apiRoot;
};

const modelUrl = (apiRoot: URL): string =>
	new URL("chat/completions", apiRoot).href;

const apiKeyForAuthorization = (
	value: unknown,
	providerName: string
): string => {
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
		`${providerName} authorization is invalid.`
	);
};

const promptPart = (
	part: ProviderChatRequest["messages"][number]["content"][number]
): ProtocolPromptPart => {
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
		content: message.content.map(promptPart),
		role: message.role,
	}));

const providerErrorFor = (
	error: unknown,
	providerName: string
): ProviderError => {
	if (error instanceof ProviderError) {
		return error;
	}
	if (error instanceof ProviderProtocolError) {
		if (error.statusCode === 401 || error.statusCode === 403) {
			return new ProviderError(
				"authentication",
				`${providerName} rejected the configured credential.`,
				{ cause: error }
			);
		}
		return new ProviderError(
			"provider",
			`${providerName} returned an invalid or incomplete stream.`,
			{ cause: error }
		);
	}
	return new ProviderError(
		"transport",
		`${providerName} response stream failed.`,
		{ cause: error }
	);
};

const streamEvents = function* (
	parts: Iterable<ProtocolStreamPart>
): Iterable<ProviderChatEvent> {
	for (const part of parts) {
		if (part.type === "finish") {
			if (part.usage) {
				yield { type: "usage", usage: part.usage };
			}
			yield { type: "finish" };
			continue;
		}
		yield part;
	}
};

const requestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext
) => {
	const requestedMaxOutputTokens = maxOutputTokensForRequest(
		request.maxOutputTokens,
		context.model
	);
	return openAICompatibleChatProtocol.serialize({
		maxOutputTokens: request.cacheWarming ? 1 : requestedMaxOutputTokens,
		messages: promptMessages(request.messages),
		modelId: context.model.modelId,
		...(request.reasoningEffort !== undefined &&
		context.model.reasoningEfforts?.includes(request.reasoningEffort)
			? { reasoningEffort: request.reasoningEffort }
			: {}),
		system: request.system,
		tools: request.tools,
	});
};

const cancelResponseBody = async (
	response: OpenAICompatibleFetchResponse
): Promise<void> => {
	await response.body?.cancel().catch(() => undefined);
};

export const openAICompatibleResponseError = async (
	response: OpenAICompatibleFetchResponse,
	providerName: string,
	operation: "model discovery" | "request"
): Promise<ProviderError> => {
	await cancelResponseBody(response);
	const isAuthenticationFailure =
		response.status === 401 || response.status === 403;
	return new ProviderError(
		isAuthenticationFailure ? "authentication" : "provider",
		isAuthenticationFailure
			? `${providerName} rejected the configured credential${operation === "model discovery" ? " during model discovery" : ""}.`
			: `${providerName} ${operation} failed (${response.status}).`
	);
};

const fetchChatResponse = async (
	providerName: string,
	apiRoot: URL,
	fetchImpl: OpenAICompatibleFetch,
	request: ProviderChatRequest,
	context: ProviderChatContext
): Promise<OpenAICompatibleFetchResponse> => {
	let response: OpenAICompatibleFetchResponse;
	try {
		response = await fetchImpl(modelUrl(apiRoot), {
			body: JSON.stringify(requestFor(request, context)),
			headers: context.headers,
			method: "POST",
			signal: context.signal,
		});
	} catch (error) {
		if (context.signal?.aborted) {
			throw context.signal.reason ?? error;
		}
		throw new ProviderError(
			"transport",
			`${providerName} network request failed.`,
			{ cause: error }
		);
	}
	if (!response.ok) {
		throw await openAICompatibleResponseError(
			response,
			providerName,
			"request"
		);
	}
	return response;
};

const streamResponse = async function* (
	providerName: string,
	response: OpenAICompatibleFetchResponse,
	signal: AbortSignal | undefined
): AsyncIterable<ProviderChatEvent> {
	try {
		for await (const event of openAICompatibleChatProtocol.stream(
			response as Response,
			signal
		)) {
			if (signal?.aborted) {
				throw signal.reason ?? new DOMException("Aborted", "AbortError");
			}
			yield* streamEvents([event]);
		}
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		throw providerErrorFor(error, providerName);
	}
};

const streamCompatibleChat = (
	providerName: string,
	apiRoot: URL,
	fetchImpl: OpenAICompatibleFetch
) =>
	async function* (
		request: ProviderChatRequest,
		context: ProviderChatContext
	): AsyncIterable<ProviderChatEvent> {
		const response = await fetchChatResponse(
			providerName,
			apiRoot,
			fetchImpl,
			request,
			context
		);
		yield* streamResponse(providerName, response, context.signal);
	};

export const createOpenAICompatibleProvider = (
	options: OpenAICompatibleProviderOptions
): Provider => {
	const apiRoot = apiRootFor(options.baseUrl);
	const fetchImpl: OpenAICompatibleFetch =
		options.fetch ?? globalThis.fetch.bind(globalThis);
	for (const model of options.models) {
		if (
			model.providerId !== options.providerId ||
			model.protocolId !== OPENAI_COMPATIBLE_PROTOCOL_ID
		) {
			throw new Error(
				`Models for ${options.providerId} must use the openai-compatible protocol.`
			);
		}
	}
	return {
		getChatHeaders: (context: ProviderChatHeaderContext) => ({
			authorization: `Bearer ${apiKeyForAuthorization(
				context.authorization,
				options.providerName
			)}`,
			"content-type": "application/json",
		}),
		id: options.providerId,
		models: options.models,
		resolveAuthorization: async ({ credential }) => {
			const parsed = apiKeyCredentialSchema.safeParse(credential);
			return parsed.success
				? { authorization: { apiKey: parsed.data.apiKey } }
				: null;
		},
		streamChat: streamCompatibleChat(options.providerName, apiRoot, fetchImpl),
	};
};

export const openAICompatibleProtocolId = OPENAI_COMPATIBLE_PROTOCOL_ID;
export {
	apiKeyForAuthorization as openAICompatibleApiKeyForAuthorization,
	apiRootFor as openAICompatibleApiRootFor,
};
