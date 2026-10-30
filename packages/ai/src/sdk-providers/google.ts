import type { JsonObject } from "type-fest";
import { apiKeyCredentialSchema } from "../credential-schemas.ts";
import { providerModels as googleProviderModels } from "../generated/google.generated.ts";
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
	createGoogleCachedContentResourceManager,
	type GoogleCachedContentClient,
	type GoogleCachedContentResourceManager,
} from "../sdk-private/google-cached-content-manager.ts";
import {
	httpErrorFromResponse,
	isCacheControlRejection,
	ProviderProtocolError,
} from "../sdk-private/protocol-errors.ts";
import { googleStrategy } from "../sdk-private/protocols/google.ts";
import type { GoogleProtocolOptions } from "../sdk-private/protocols/provider-options.ts";
import type {
	GoogleCachedContentSelection,
	ProtocolPromptMessage,
	ProtocolPromptPart,
	ProtocolTool,
	ProviderProtocolRequest,
} from "../sdk-private/protocols/request.ts";
import { unreachableValue } from "../sdk-private/protocols/shared.ts";
import { providerChatFinish } from "../sdk-private/provider-events.ts";

const GOOGLE_PROVIDER_ID = "google";
const GOOGLE_PROTOCOL_ID = "google";
const GOOGLE_API_ROOT =
	"https://generativelanguage.googleapis.com/v1beta/models";
const TRAILING_SLASHES = /\/+$/u;
const GOOGLE_FORWARDED_REASONING_EFFORTS = new Set([
	"none",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
]);

export type GoogleFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export type GoogleProviderOptions = Readonly<{
	/** API base URL; `/v1beta/models` is appended when it is not present. */
	baseUrl?: string;
	createCacheClient?: (apiKey: string) => GoogleCachedContentClient;
	fetch?: GoogleFetch;
	models?: readonly ProviderModel[];
	sessionId?: string;
}>;

export type GoogleProvider = Provider &
	Readonly<{ close: () => Promise<void> }>;

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
	context: ProviderChatContext,
	cachedContent?: GoogleCachedContentSelection
): ProviderProtocolRequest => {
	const reasoningEffort =
		!request.cacheWarming &&
		request.reasoningEffort !== undefined &&
		context.model.reasoningEfforts?.includes(request.reasoningEffort)
			? request.reasoningEffort
			: undefined;
	return {
		...(request.cacheWarming === true ? { cacheWarming: true } : {}),
		...(cachedContent === undefined
			? {}
			: { googleCachedContent: cachedContent }),
		...(request.cacheRetention === undefined
			? {}
			: {
					promptCacheEnabled: true,
					promptCacheRetention: request.cacheRetention,
				}),
		...(reasoningEffort === undefined ? {} : { reasoningEffort }),
		messages: request.messages.map(promptMessage),
		modelId: context.model.modelId,
		...(request.promptCacheKey === undefined
			? {}
			: { promptCacheKey: request.promptCacheKey }),
		signal: context.signal,
		system: request.system,
		tools: modelTools(request.tools),
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
	throw new ProviderError("authentication", "Google authorization is invalid.");
};

const googleChatHeadersFor = (
	context: ProviderChatHeaderContext
): Readonly<Record<string, string>> => ({
	"content-type": "application/json",
	"x-goog-api-key": apiKeyFor(context.authorization),
});

const providerErrorFor = (error: unknown): ProviderError => {
	if (error instanceof ProviderError) {
		return error;
	}
	if (error instanceof ProviderProtocolError) {
		if (error.statusCode === 401 || error.statusCode === 403) {
			return new ProviderError(
				"authentication",
				"Google rejected the configured credential.",
				{ cause: error }
			);
		}
		return new ProviderError(
			"provider",
			error.statusCode === undefined
				? "Google returned an invalid or incomplete stream."
				: `Google request failed (${error.statusCode}).`,
			{ cause: error }
		);
	}
	return new ProviderError("transport", "Google network request failed.", {
		cause: error,
	});
};

const googleApiRootFor = (baseUrl: string | undefined): string => {
	if (baseUrl === undefined) {
		return GOOGLE_API_ROOT;
	}
	const url = new URL(baseUrl);
	const path = url.pathname.replace(TRAILING_SLASHES, "");
	if (path.endsWith("/models")) {
		url.pathname = path;
	} else if (path.endsWith("/v1beta")) {
		url.pathname = `${path}/models`;
	} else {
		url.pathname = `${path}/v1beta/models`;
	}
	url.search = "";
	url.hash = "";
	return url.href.replace(TRAILING_SLASHES, "");
};

const apiUrlFor = (modelId: string, apiRoot: string): string =>
	`${apiRoot}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;

const googleProviderOptionsFor = (
	reasoningEffort: ProviderProtocolRequest["reasoningEffort"]
): GoogleProtocolOptions | undefined => {
	if (reasoningEffort === "off") {
		return { thinkingConfig: { thinkingBudget: 0 } };
	}
	if (
		reasoningEffort === "minimal" ||
		reasoningEffort === "low" ||
		reasoningEffort === "medium" ||
		reasoningEffort === "high"
	) {
		return { thinkingConfig: { thinkingLevel: reasoningEffort } };
	}
	return;
};

const streamRequest = async function* (
	request: ProviderProtocolRequest,
	headers: Readonly<Record<string, string>>,
	maxOutputTokens: number | undefined,
	fetchImpl: GoogleFetch,
	apiRoot: string
): AsyncIterable<ProviderChatEvent> {
	const body = googleStrategy.serialize({
		maxOutputTokens,
		providerOptions: googleProviderOptionsFor(request.reasoningEffort),
		request,
	});
	let response: Response;
	try {
		response = await fetchImpl(apiUrlFor(request.modelId, apiRoot), {
			body: JSON.stringify(body),
			headers,
			method: "POST",
			signal: request.signal,
		});
	} catch (error) {
		if (request.signal?.aborted) {
			throw request.signal.reason ?? error;
		}
		throw new ProviderError("transport", "Google network request failed.", {
			cause: error,
		});
	}
	if (!response.ok) {
		throw await httpErrorFromResponse(response);
	}
	for await (const part of googleStrategy.stream(response, request.signal)) {
		if (request.signal?.aborted) {
			throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		if (part.type === "finish") {
			if (part.usage) {
				yield { type: "usage", usage: part.usage };
			}
			yield providerChatFinish(part);
		} else {
			yield part;
		}
	}
};

const cacheSelectionFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	apiKey: string,
	cacheManager: GoogleCachedContentResourceManager
) =>
	request.cacheRetention === undefined
		? undefined
		: cacheManager.select({
				apiKey,
				cacheRetention: request.cacheRetention,
				modelId: context.model.modelId,
				providerId: context.model.providerId,
				system: request.system ?? "",
				tools: modelTools(request.tools) ?? [],
			});

const shouldRetryWithoutCache = (
	error: unknown,
	outputStarted: boolean,
	selectedCache: GoogleCachedContentSelection | undefined,
	signal: AbortSignal | undefined,
	cacheWarming: boolean
): boolean =>
	!(cacheWarming || outputStarted) &&
	selectedCache !== undefined &&
	isCacheControlRejection(error) &&
	!signal?.aborted;

const streamWithCacheFallback = async function* (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	selectedCache: GoogleCachedContentSelection | undefined,
	fetchImpl: GoogleFetch,
	apiRoot: string
): AsyncIterable<ProviderChatEvent> {
	let outputStarted = false;
	const requestedMaxOutputTokens = maxOutputTokensForRequest(
		request.maxOutputTokens,
		context.model
	);
	const maxOutputTokens = request.cacheWarming ? 1 : requestedMaxOutputTokens;
	try {
		for await (const event of streamRequest(
			modelRequestFor(request, context, selectedCache),
			context.headers,
			maxOutputTokens,
			fetchImpl,
			apiRoot
		)) {
			if (event.type !== "finish") {
				outputStarted = true;
			}
			yield event;
		}
	} catch (error) {
		if (
			selectedCache === undefined ||
			!shouldRetryWithoutCache(
				error,
				outputStarted,
				selectedCache,
				context.signal,
				request.cacheWarming === true
			)
		) {
			throw error;
		}
		await selectedCache.onRejected?.(selectedCache.name);
		yield* streamRequest(
			modelRequestFor(request, context),
			context.headers,
			maxOutputTokens,
			fetchImpl,
			apiRoot
		);
	}
};

const streamGoogle = (
	fetchImpl: GoogleFetch,
	cacheManager: GoogleCachedContentResourceManager,
	apiRoot: string
) =>
	async function* (
		request: ProviderChatRequest,
		context: ProviderChatContext
	): AsyncIterable<ProviderChatEvent> {
		try {
			const apiKey = apiKeyFor(context.authorization);
			const selectedCache = await cacheSelectionFor(
				request,
				context,
				apiKey,
				cacheManager
			);
			if (context.signal?.aborted) {
				throw (
					context.signal.reason ?? new DOMException("Aborted", "AbortError")
				);
			}
			yield* streamWithCacheFallback(
				request,
				context,
				selectedCache,
				fetchImpl,
				apiRoot
			);
		} catch (error) {
			if (context.signal?.aborted) {
				throw context.signal.reason ?? error;
			}
			throw providerErrorFor(error);
		}
	};

/** Creates a Google SDK Provider with its own optional CachedContent lifecycle. */
export const createGoogleProvider = (
	options: GoogleProviderOptions = {}
): GoogleProvider => {
	const fetchImpl: GoogleFetch =
		options.fetch ?? globalThis.fetch.bind(globalThis);
	const apiRoot = googleApiRootFor(options.baseUrl);
	const models: readonly ProviderModel[] =
		options.models ??
		googleProviderModels.map((model: ProviderModel) =>
			model.reasoningEfforts === undefined
				? model
				: {
						...model,
						reasoningEfforts: model.reasoningEfforts.filter((effort) =>
							GOOGLE_FORWARDED_REASONING_EFFORTS.has(effort)
						),
					}
		);
	if (
		models.some(
			(model) =>
				model.providerId !== GOOGLE_PROVIDER_ID ||
				model.protocolId !== GOOGLE_PROTOCOL_ID
		)
	) {
		throw new Error(
			"Google provider models must use provider ID and protocol ID google."
		);
	}
	const modelsById = new Map(models.map((model) => [model.modelId, model]));
	const cacheManager = createGoogleCachedContentResourceManager({
		bestEffortCacheCreation: true,
		cacheTtlForModel: (modelId, retention) => {
			const promptCache = modelsById.get(modelId)?.promptCache;
			return promptCache?.explicit.retentionTiers.includes(retention)
				? promptCache.googleCachedContent?.ttl[retention]
				: undefined;
		},
		createClient: options.createCacheClient,
		sessionId: options.sessionId ?? globalThis.crypto.randomUUID(),
	});
	return {
		close: () => cacheManager.close(),
		id: GOOGLE_PROVIDER_ID,
		models,
		resolveAuthorization: async ({ credential }) => {
			const parsed = apiKeyCredentialSchema.safeParse(credential);
			return parsed.success
				? { authorization: { apiKey: parsed.data.apiKey } }
				: null;
		},
		getChatHeaders: googleChatHeadersFor,
		streamChat: streamGoogle(fetchImpl, cacheManager, apiRoot),
	};
};
