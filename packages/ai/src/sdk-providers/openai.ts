import type { JsonObject } from "type-fest";
import { openAICredentialSchema } from "../connections/credential-schemas.ts";
import {
	httpErrorFromResponse,
	isCacheControlRejection,
	ModelProviderError,
} from "../model-client/errors.ts";
import { openAIChatStrategy } from "../model-client/protocols/openai-chat.ts";
import { openAIResponsesStrategy } from "../model-client/protocols/openai-responses.ts";
import { unreachableValue } from "../model-client/protocols/shared.ts";
import type { ModelProtocolStrategy } from "../model-client/protocols/types";
import type {
	ModelPromptMessage,
	ModelPromptPart,
	ModelStepRequest,
	ModelTool,
} from "../model-client/types";
import type { ModelTarget } from "../model-target";
import type { SupportedChatModel } from "../models";
import {
	type ChatContentPart,
	type Provider,
	type ProviderChatContext,
	type ProviderChatEvent,
	type ProviderChatRequest,
	ProviderError,
	type ProviderModel,
} from "../sdk.ts";
import {
	acquireOpenAIOAuthCredential,
	type OpenAIBrowserLoginOptions,
	type OpenAIFetch,
	type OpenAIOAuthCredential,
	OpenAIOAuthRefreshError,
	refreshOpenAIOAuthCredential,
} from "../sdk-private/openai-oauth.ts";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_RESPONSES_PROTOCOL = "openai-responses";
const OPENAI_CHAT_PROTOCOL = "openai-chat";
const OPENAI_OAUTH_RESPONSES_URL =
	"https://chatgpt.com/backend-api/codex/responses";
const TRAILING_SLASHES = /\/+$/u;
const DEFAULT_MODELS = [
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
	"gpt-6-luna",
	"gpt-6-terra",
	"gpt-6-astra",
].map(
	(modelId): ProviderModel => ({
		modelId,
		protocolId: OPENAI_RESPONSES_PROTOCOL,
		providerId: OPENAI_PROVIDER_ID,
	})
);

export type OpenAIAuthorization =
	| Readonly<{ apiKey: string; kind: "api-key" }>
	| Readonly<{ accountId: string; accessToken: string; kind: "oauth" }>;

export type OpenAIProviderOptions = Readonly<{
	/** API root used for API-key Responses and Chat Completions routes. */
	baseUrl?: string;
	fetch?: OpenAIFetch;
	/** OAuth login seam; the returned credential is stored by the application via ProviderCollection. */
	login?: (
		options: OpenAIBrowserLoginOptions
	) => Promise<OpenAIOAuthCredential>;
	models?: readonly ProviderModel[];
}>;

export type OpenAIProvider = Provider &
	Readonly<{
		login: (
			options?: OpenAIBrowserLoginOptions
		) => Promise<OpenAIOAuthCredential>;
	}>;

const apiRootFor = (baseUrl: string): URL => {
	const apiRoot = new URL(baseUrl);
	apiRoot.pathname = `${apiRoot.pathname.replace(TRAILING_SLASHES, "")}/`;
	apiRoot.search = "";
	apiRoot.hash = "";
	return apiRoot;
};

const parseAuthorization = (value: unknown): OpenAIAuthorization => {
	if (typeof value !== "object" || value === null) {
		throw new ProviderError(
			"authentication",
			"OpenAI authorization is invalid."
		);
	}
	const authorization = value as Record<string, unknown>;
	if (
		authorization.kind === "api-key" &&
		typeof authorization.apiKey === "string" &&
		authorization.apiKey.length > 0
	) {
		return { apiKey: authorization.apiKey, kind: "api-key" };
	}
	if (
		authorization.kind === "oauth" &&
		typeof authorization.accessToken === "string" &&
		authorization.accessToken.length > 0 &&
		typeof authorization.accountId === "string" &&
		authorization.accountId.length > 0
	) {
		return {
			accountId: authorization.accountId,
			accessToken: authorization.accessToken,
			kind: "oauth",
		};
	}
	throw new ProviderError("authentication", "OpenAI authorization is invalid.");
};

const modelForProtocol = (model: ProviderModel): SupportedChatModel =>
	({
		connectionProviderId: OPENAI_PROVIDER_ID,
		displayName: model.modelId,
		id: model.modelId as SupportedChatModel["id"],
		lifecycle: "active",
		provider: OPENAI_PROVIDER_ID,
		route: "direct",
	}) as SupportedChatModel;

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
	authorization: OpenAIAuthorization,
	cacheRetention: ProviderChatRequest["cacheRetention"]
): ModelStepRequest => {
	const targetAuthorization =
		authorization.kind === "api-key"
			? { apiKey: authorization.apiKey, kind: "api-key" as const }
			: {
					accessToken: authorization.accessToken,
					accountId: authorization.accountId,
					kind: "oauth" as const,
				};
	const target: ModelTarget = {
		authorization: targetAuthorization,
		modelId: context.model.modelId as Extract<
			ModelTarget,
			{ providerId: "openai" }
		>["modelId"],
		providerId: OPENAI_PROVIDER_ID,
		...(cacheRetention === undefined
			? {}
			: {
					promptCacheEnabled: true,
					promptCacheRetention: cacheRetention,
				}),
	};
	return {
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

type OpenAIWireRequest = Readonly<{
	body: string;
	hasCacheControls: boolean;
	headers: Readonly<Record<string, string>>;
	strategy: ModelProtocolStrategy;
	url: string;
}>;

const wireRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	authorization: OpenAIAuthorization,
	apiRoot: URL,
	cacheRetention: ProviderChatRequest["cacheRetention"]
): OpenAIWireRequest => {
	const model = modelForProtocol(context.model);
	const modelRequest = modelRequestFor(
		request,
		context,
		authorization,
		cacheRetention
	);
	const jsonHeaders = { "content-type": "application/json" };
	const protocolId = context.model.protocolId;
	let strategy: ModelProtocolStrategy;
	let body: Record<string, unknown>;
	let url: string;
	let headers: Readonly<Record<string, string>>;
	if (protocolId === OPENAI_RESPONSES_PROTOCOL) {
		strategy = openAIResponsesStrategy;
		body = strategy.serialize({
			maxOutputTokens: undefined,
			model,
			omitOutputTokenLimit: authorization.kind === "oauth",
			providerOptions: undefined,
			request: modelRequest,
		});
		if (authorization.kind === "oauth") {
			url = OPENAI_OAUTH_RESPONSES_URL;
			headers = {
				...jsonHeaders,
				authorization: `Bearer ${authorization.accessToken}`,
				"chatgpt-account-id": authorization.accountId,
				"openai-beta": "responses=experimental",
				originator: "wincode",
			};
		} else {
			url = new URL("responses", apiRoot).href;
			headers = {
				...jsonHeaders,
				authorization: `Bearer ${authorization.apiKey}`,
			};
		}
	} else if (protocolId === OPENAI_CHAT_PROTOCOL) {
		if (authorization.kind === "oauth") {
			throw new ProviderError(
				"provider",
				"OpenAI OAuth supports the Responses protocol only."
			);
		}
		strategy = openAIChatStrategy;
		body = strategy.serialize({
			maxOutputTokens: undefined,
			model,
			request: modelRequest,
		});
		url = new URL("chat/completions", apiRoot).href;
		headers = {
			...jsonHeaders,
			authorization: `Bearer ${authorization.apiKey}`,
		};
	} else {
		throw new ProviderError(
			"provider",
			`Unsupported OpenAI model protocol: ${protocolId}`
		);
	}
	return {
		body: JSON.stringify(body),
		hasCacheControls:
			cacheRetention !== undefined &&
			strategy.promptCache.routeForModel(model)?.hasControls === true,
		headers,
		strategy,
		url,
	};
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

const providerErrorFor = (error: unknown): ProviderError => {
	if (error instanceof ProviderError) {
		return error;
	}
	if (error instanceof ModelProviderError) {
		if (error.statusCode === 401 || error.statusCode === 403) {
			return new ProviderError(
				"authentication",
				"OpenAI rejected the configured credential.",
				{ cause: error }
			);
		}
		return new ProviderError(
			"provider",
			error.statusCode === undefined
				? "OpenAI returned an invalid or incomplete stream."
				: `OpenAI request failed (${error.statusCode}).`,
			{ cause: error }
		);
	}
	return new ProviderError("transport", "OpenAI network request failed.", {
		cause: error,
	});
};

const streamWireRequest = async function* (
	wireRequest: OpenAIWireRequest,
	fetchImpl: OpenAIFetch,
	signal?: AbortSignal
): AsyncIterable<ProviderChatEvent> {
	let response: Response;
	try {
		response = await fetchImpl(wireRequest.url, {
			body: wireRequest.body,
			headers: wireRequest.headers,
			method: "POST",
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		throw new ProviderError("transport", "OpenAI network request failed.", {
			cause: error,
		});
	}
	if (!response.ok) {
		throw await httpErrorFromResponse(response);
	}
	for await (const part of wireRequest.strategy.stream(response, signal)) {
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
	authorization: OpenAIAuthorization,
	apiRoot: URL,
	fetchImpl: OpenAIFetch,
	cachedRequest: OpenAIWireRequest
): AsyncIterable<ProviderChatEvent> {
	let outputStarted = false;
	try {
		for await (const event of streamWireRequest(
			cachedRequest,
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
			apiRoot,
			undefined
		);
		yield* streamWireRequest(uncachedRequest, fetchImpl, context.signal);
	}
};

const openAIStreamChat = (fetchImpl: OpenAIFetch, apiRoot: URL) =>
	async function* (
		request: ProviderChatRequest,
		context: ProviderChatContext
	): AsyncIterable<ProviderChatEvent> {
		try {
			const authorization = parseAuthorization(context.authorization);
			const cachedRequest = wireRequestFor(
				request,
				context,
				authorization,
				apiRoot,
				request.cacheRetention
			);
			yield* streamWithCacheFallback(
				request,
				context,
				authorization,
				apiRoot,
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

export const createOpenAIProvider = (
	options: OpenAIProviderOptions = {}
): OpenAIProvider => {
	const fetchImpl: OpenAIFetch =
		options.fetch ?? globalThis.fetch.bind(globalThis);
	const apiRoot = apiRootFor(options.baseUrl ?? "https://api.openai.com/v1/");
	const models = options.models ?? DEFAULT_MODELS;
	if (models.some((model) => model.providerId !== OPENAI_PROVIDER_ID)) {
		throw new Error("OpenAI provider models must use provider ID openai.");
	}
	return {
		id: OPENAI_PROVIDER_ID,
		models,
		login: (loginOptions = {}) =>
			(
				options.login ??
				((input) => acquireOpenAIOAuthCredential(input, fetchImpl))
			)(loginOptions),
		resolveAuthorization: async ({ credential, signal }) => {
			const parsedCredential = openAICredentialSchema.safeParse(credential);
			if (!parsedCredential.success) {
				return null;
			}
			if (parsedCredential.data.kind === "api-key") {
				return {
					authorization: {
						apiKey: parsedCredential.data.apiKey,
						kind: "api-key",
					},
				};
			}
			try {
				const next = await refreshOpenAIOAuthCredential(
					parsedCredential.data,
					fetchImpl,
					signal
				);
				return {
					authorization: {
						accountId: next.accountId,
						accessToken: next.accessToken,
						kind: "oauth",
					},
					...(next === parsedCredential.data ? {} : { credential: next }),
				};
			} catch (error) {
				if (signal?.aborted) {
					throw signal.reason ?? error;
				}
				throw new ProviderError(
					error instanceof OpenAIOAuthRefreshError
						? error.code
						: "authentication",
					error instanceof OpenAIOAuthRefreshError
						? error.message
						: "OpenAI OAuth credentials expired; sign in again.",
					{ cause: error }
				);
			}
		},
		streamChat: openAIStreamChat(fetchImpl, apiRoot),
	};
};

export type { OpenAICredential } from "../connections/credential-schemas.ts";
