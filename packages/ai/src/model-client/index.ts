import type { ModelTarget } from "../model-target";
import { findSupportedChatModelSelection } from "../models";
import { httpErrorFromResponse } from "./errors";
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

export type {
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
	const response = await fetchImpl(providerRequest.url, {
		...providerRequest.init,
		signal: request.signal,
	});
	if (!response.ok) {
		throw await httpErrorFromResponse(response);
	}
	for await (const part of streamProviderResponse(
		providerRequest.protocol,
		response,
		request.signal
	)) {
		yield part;
	}
};

export const createModelClient = (
	options: ModelClientOptions = {}
): ModelClient => {
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	return { stream: (request) => streamModel(request, fetchImpl) };
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
