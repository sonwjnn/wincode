import type { JsonObject } from "type-fest";
import { apiKeyCredentialSchema } from "../connections/credential-schemas.ts";
import { googleModelMetadataById } from "../generated/google-model-metadata.generated.ts";
import { googleSdkModels } from "../generated/google-sdk-models.generated.ts";
import {
	httpErrorFromResponse,
	isCacheControlRejection,
	ModelProviderError,
} from "../model-client/errors.ts";
import {
	createGoogleCachedContentResourceManager,
	type GoogleCachedContentClient,
	type GoogleCachedContentResourceManager,
} from "../model-client/google-cached-content-manager.ts";
import { googleStrategy } from "../model-client/protocols/google.ts";
import { unreachableValue } from "../model-client/protocols/shared.ts";
import type {
	ModelPromptMessage,
	ModelPromptPart,
	ModelStepRequest,
	ModelTool,
} from "../model-client/types.ts";
import type { ModelTarget } from "../model-target.ts";
import {
	type ChatContentPart,
	type Provider,
	type ProviderChatContext,
	type ProviderChatEvent,
	type ProviderChatRequest,
	ProviderError,
	type ProviderModel,
} from "../sdk.ts";

const GOOGLE_PROVIDER_ID = "google";
const GOOGLE_PROTOCOL_ID = "google";
const GOOGLE_API_ROOT =
	"https://generativelanguage.googleapis.com/v1beta/models";

export type GoogleFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export type GoogleProviderOptions = Readonly<{
	createCacheClient?: (apiKey: string) => GoogleCachedContentClient;
	fetch?: GoogleFetch;
	models?: readonly ProviderModel[];
	sessionId?: string;
}>;

export type GoogleProvider = Provider &
	Readonly<{ close: () => Promise<void> }>;

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
		providerId: GOOGLE_PROVIDER_ID,
	}) as ModelTarget;

const modelRequestFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	apiKey: string,
	cachedContent?: ModelStepRequest["googleCachedContent"]
): ModelStepRequest => ({
	...(cachedContent === undefined
		? {}
		: { googleCachedContent: cachedContent }),
	messages: request.messages.map(promptMessage),
	signal: context.signal,
	system: request.system,
	target: modelTargetFor(context.model.modelId, apiKey, request.cacheRetention),
	tools: modelTools(request.tools),
});

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

const providerErrorFor = (error: unknown): ProviderError => {
	if (error instanceof ProviderError) {
		return error;
	}
	if (error instanceof ModelProviderError) {
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

const apiUrlFor = (modelId: string): string =>
	`${GOOGLE_API_ROOT}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;

const streamRequest = async function* (
	request: ModelStepRequest,
	apiKey: string,
	fetchImpl: GoogleFetch
): AsyncIterable<ProviderChatEvent> {
	const body = googleStrategy.serialize({
		maxOutputTokens: undefined,
		providerOptions: undefined,
		request,
	});
	let response: Response;
	try {
		response = await fetchImpl(apiUrlFor(request.target.modelId), {
			body: JSON.stringify(body),
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": apiKey,
			},
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

const cacheSelectionFor = (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	apiKey: string,
	cacheManager: GoogleCachedContentResourceManager
) =>
	request.cacheRetention === undefined
		? undefined
		: cacheManager.select({
				system: request.system ?? "",
				target: modelTargetFor(
					context.model.modelId,
					apiKey,
					request.cacheRetention
				),
				tools: modelTools(request.tools) ?? [],
			});

const shouldRetryWithoutCache = (
	error: unknown,
	outputStarted: boolean,
	selectedCache: ModelStepRequest["googleCachedContent"],
	signal: AbortSignal | undefined
): boolean =>
	!outputStarted &&
	selectedCache !== undefined &&
	isCacheControlRejection(error) &&
	!signal?.aborted;

const streamWithCacheFallback = async function* (
	request: ProviderChatRequest,
	context: ProviderChatContext,
	apiKey: string,
	selectedCache: ModelStepRequest["googleCachedContent"],
	fetchImpl: GoogleFetch
): AsyncIterable<ProviderChatEvent> {
	let outputStarted = false;
	try {
		for await (const event of streamRequest(
			modelRequestFor(request, context, apiKey, selectedCache),
			apiKey,
			fetchImpl
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
				context.signal
			)
		) {
			throw error;
		}
		await selectedCache.onRejected?.(selectedCache.name);
		yield* streamRequest(
			modelRequestFor(request, context, apiKey),
			apiKey,
			fetchImpl
		);
	}
};

const streamGoogle = (
	fetchImpl: GoogleFetch,
	cacheManager: GoogleCachedContentResourceManager
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
				apiKey,
				selectedCache,
				fetchImpl
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
	const models = options.models ?? googleSdkModels;
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
	const cacheManager = createGoogleCachedContentResourceManager({
		bestEffortCacheCreation: true,
		cacheTtlForModel: (modelId, retention) => {
			const promptCache = googleModelMetadataById[modelId]?.promptCache;
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
		streamChat: streamGoogle(fetchImpl, cacheManager),
	};
};
