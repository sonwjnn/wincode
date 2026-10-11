import type { ModelTarget } from "../model-target";
import type { ModelUsage } from "../model-usage";
import { findSupportedChatModelSelection } from "../models";
import { httpErrorFromResponse, isCacheControlRejection } from "./errors";
import type { SerializedProviderRequest } from "./request";
import { buildProviderRequest } from "./request";
import { streamProviderResponse } from "./stream";
import type {
	ModelClient,
	ModelClientOptions,
	ModelPromptMessage,
	ModelStepRequest,
	ModelStreamPart,
	ModelTextGenerationOptions,
	ModelTextGenerationResult,
} from "./types";

export * from "./google-cached-content";

export type {
	GoogleCachedContentSelection,
	ModelClient,
	ModelClientOptions,
	ModelPromptMessage,
	ModelPromptPart,
	ModelStepRequest,
	ModelStreamPart,
	ModelTextGenerationMessage,
	ModelTextGenerationOptions,
	ModelTextGenerationResult,
	ModelTextGenerationSource,
	ModelTool,
} from "./types";

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw (
			signal.reason ??
			new DOMException("The operation was aborted.", "AbortError")
		);
	}
};

const streamProviderRequest = async function* (
	request: ModelStepRequest,
	providerRequest: SerializedProviderRequest,
	fetchImpl: typeof fetch
): AsyncIterable<ModelStreamPart> {
	const response = await fetchImpl(providerRequest.url, {
		...providerRequest.init,
		signal: request.signal,
	});
	if (!response.ok) {
		throw await httpErrorFromResponse(response);
	}
	for await (const part of streamProviderResponse(
		providerRequest.strategy,
		response,
		request.signal
	)) {
		yield part;
	}
};

const uncachedRetryRequest = (request: ModelStepRequest): ModelStepRequest => {
	const {
		googleCachedContent: _googleCachedContent,
		promptCacheKey: _promptCacheKey,
		...uncachedRequest
	} = request;
	const {
		promptCacheEnabled: _promptCacheEnabled,
		promptCacheRetention: _promptCacheRetention,
		...target
	} = request.target;
	return { ...uncachedRequest, target };
};

const streamModel = async function* (
	request: ModelStepRequest,
	fetchImpl: typeof fetch
): AsyncIterable<ModelStreamPart> {
	throwIfAborted(request.signal);
	const model = findSupportedChatModelSelection({
		modelId: request.target.modelId,
		providerId: request.target.providerId,
	});
	if (!model) {
		throw new Error(
			`Unsupported model target: ${request.target.providerId}/${request.target.modelId}`
		);
	}
	const providerRequest = buildProviderRequest(request, model);
	let outputStarted = false;
	try {
		for await (const part of streamProviderRequest(
			request,
			providerRequest,
			fetchImpl
		)) {
			outputStarted = true;
			yield part;
		}
	} catch (error) {
		if (
			request.cacheWarming ||
			outputStarted ||
			request.signal?.aborted ||
			!providerRequest.usesPromptCacheControls ||
			!isCacheControlRejection(error)
		) {
			throw error;
		}
		try {
			await request.googleCachedContent?.onRejected?.(
				request.googleCachedContent.name
			);
		} catch {
			// Resource cleanup is best-effort; the uncached request remains usable.
		}
		throwIfAborted(request.signal);
		const retryRequest = uncachedRetryRequest(request);
		const uncachedProviderRequest = buildProviderRequest(retryRequest, model);
		for await (const part of streamProviderRequest(
			retryRequest,
			uncachedProviderRequest,
			fetchImpl
		)) {
			yield part;
		}
	}
};

export const createModelClient = (
	options: ModelClientOptions = {}
): ModelClient => {
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	return { stream: (request) => streamModel(request, fetchImpl) };
};

/** Replays a streaming Model request with one output token and discarded output. */
export const warmModelRequest = async (
	request: ModelStepRequest,
	modelClient: ModelClient = createModelClient(),
	signal?: AbortSignal
): Promise<ModelUsage | undefined> => {
	if (request.target.providerId === "google" || request.googleCachedContent) {
		return;
	}
	const {
		googleCachedContent: _googleCachedContent,
		signal: _requestSignal,
		...promptRequest
	} = request;
	const { providerOptions: _providerOptions, ...target } = request.target;
	let usage: ModelUsage | undefined;
	for await (const part of modelClient.stream({
		...promptRequest,
		cacheWarming: true,
		signal,
		target: {
			...target,
			maxOutputTokens: 1,
			thinkingLevel: undefined,
		},
	})) {
		if (part.type === "finish") {
			usage = part.usage;
		}
	}
	return usage;
};

export const generateModelText = async (
	options: ModelTextGenerationOptions,
	modelClient: ModelClient = createModelClient()
): Promise<ModelTextGenerationResult> => {
	const hasPrompt = typeof options.prompt === "string";
	const hasMessages = Array.isArray(options.messages);
	if (hasPrompt === hasMessages) {
		throw new Error("Provide exactly one of prompt or messages.");
	}
	const messages: readonly ModelPromptMessage[] = hasPrompt
		? [
				{
					role: "user",
					content: [{ type: "text", text: options.prompt as string }],
				},
			]
		: (options.messages ?? []).map((message) => ({
				role: message.role,
				content: [{ type: "text" as const, text: message.content }],
			}));
	const target: ModelTarget = {
		...options.model,
		maxOutputTokens: options.maxOutputTokens,
	};
	let text = "";
	let usage: ModelTextGenerationResult["usage"];
	for await (const part of modelClient.stream({
		messages,
		signal: options.signal,
		system: options.system,
		target,
	})) {
		if (part.type === "text-delta") {
			text += part.delta;
		} else if (part.type === "finish") {
			usage = part.usage;
		}
	}
	return { text, ...(usage ? { usage } : {}) };
};
