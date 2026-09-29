import { normalizeModelUsage } from "../../model-usage";
import { readSseEvents } from "../sse";
import type {
	ModelPromptMessage,
	ModelPromptPart,
	ModelStreamPart,
} from "../types";
import {
	base64,
	incompleteStreamError,
	type JsonRecord,
	payloadFrom,
	providerError,
	record,
	type SsePayload,
	stringValue,
	unreachableValue,
} from "./shared";
import type {
	ModelProtocolStrategy,
	ProtocolRequestContextByProtocol,
} from "./types";

const googleParts = (content: readonly ModelPromptPart[]): JsonRecord[] => {
	const parts: JsonRecord[] = [];
	for (const part of content) {
		switch (part.type) {
			case "text":
				parts.push({ text: part.text });
				break;
			case "file":
				parts.push({
					inlineData: { mimeType: part.mediaType, data: base64(part.data) },
				});
				break;
			case "tool-call":
				parts.push({
					functionCall: {
						name: part.toolName,
						args: part.input,
						id: part.toolCallId,
					},
				});
				break;
			case "tool-result":
				parts.push({
					functionResponse: {
						id: part.toolCallId,
						name: part.toolName,
						response: record(part.output) ?? { result: part.output },
					},
				});
				break;
			case "tool-failure":
				parts.push({
					functionResponse: {
						id: part.toolCallId,
						name: part.toolName,
						response: { error: part.errorText },
					},
				});
				break;
			default:
				unreachableValue(part);
		}
	}
	return parts;
};

const googleContents = (
	messages: readonly ModelPromptMessage[]
): JsonRecord[] => {
	const contents: JsonRecord[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.continuation)) {
			contents.push({ role: "model", parts: message.continuation });
			continue;
		}
		const parts = googleParts(message.content);
		if (parts.length > 0) {
			contents.push({
				role: message.role === "assistant" ? "model" : "user",
				parts,
			});
		}
	}
	return contents;
};
const googleUsage = (usageValue: unknown): unknown => {
	const usage = record(usageValue);
	if (!usage) {
		return;
	}
	return {
		inputTokens: usage.promptTokenCount,
		outputTokens: usage.candidatesTokenCount,
		reasoningTokens: usage.thoughtsTokenCount,
		totalTokens: usage.totalTokenCount,
		cachedInputTokens: usage.cachedContentTokenCount,
	};
};

type GoogleStreamState = {
	completed: boolean;
	continuation: unknown[];
	toolSequence: number;
	usage: unknown;
};

const googleContentPartParts = function* (
	valuePart: unknown,
	state: GoogleStreamState
): Iterable<ModelStreamPart> {
	const part = record(valuePart);
	if (!part) {
		return;
	}
	const functionCall = record(part.functionCall);
	const toolName = stringValue(functionCall?.name);
	let toolCallId: string | undefined;
	if (functionCall && toolName) {
		state.toolSequence += 1;
		toolCallId =
			stringValue(functionCall.id) ?? `google-tool-${state.toolSequence}`;
		state.continuation.push({
			...part,
			functionCall: { ...functionCall, id: toolCallId },
		});
	} else {
		state.continuation.push({ ...part });
	}
	const text = stringValue(part.text);
	if (text !== undefined) {
		yield {
			type: part.thought === true ? "reasoning-delta" : "text-delta",
			delta: text,
		};
	}
	if (functionCall && toolName && toolCallId) {
		yield {
			type: "tool-call",
			toolCallId,
			toolName,
			input: functionCall.args ?? {},
		};
	}
};

const googleEventParts = function* (
	payload: SsePayload,
	response: Response,
	state: GoogleStreamState
): Iterable<ModelStreamPart> {
	const error = providerError(payload, response);
	if (error) {
		throw error;
	}
	const value = payload.value;
	const candidates = Array.isArray(value.candidates) ? value.candidates : [];
	const candidate = record(candidates[0]);
	if (stringValue(candidate?.finishReason) !== undefined) {
		state.completed = true;
	}
	const promptFeedback = record(value.promptFeedback);
	if (stringValue(promptFeedback?.blockReason) !== undefined) {
		state.completed = true;
	}
	const content = record(candidate?.content);
	const parts = Array.isArray(content?.parts) ? content.parts : [];
	for (const valuePart of parts) {
		yield* googleContentPartParts(valuePart, state);
	}
	state.usage = googleUsage(value.usageMetadata) ?? state.usage;
};

const googleStream = async function* (
	response: Response,
	signal?: AbortSignal
): AsyncIterable<ModelStreamPart> {
	const state: GoogleStreamState = {
		completed: false,
		continuation: [],
		toolSequence: 0,
		usage: undefined,
	};
	for await (const event of readSseEvents(
		response.body as ReadableStream<Uint8Array>,
		signal
	)) {
		const payload = payloadFrom(event.data, event.event);
		if (!payload) {
			continue;
		}
		yield* googleEventParts(payload, response, state);
	}
	if (!state.completed) {
		throw incompleteStreamError("google");
	}
	const normalized = normalizeModelUsage(state.usage);
	yield {
		type: "finish",
		...(normalized ? { usage: normalized } : {}),
		...(state.continuation.length > 0
			? { continuation: state.continuation }
			: {}),
	};
};
const serializeGoogle = (
	context: ProtocolRequestContextByProtocol["google"]
): JsonRecord => {
	const { request, maxOutputTokens, providerOptions } = context;
	const generationConfig: JsonRecord = {};
	if (maxOutputTokens !== undefined) {
		generationConfig.maxOutputTokens = maxOutputTokens;
	}
	const thinkingConfig = providerOptions?.thinkingConfig;
	if (thinkingConfig) {
		generationConfig.thinkingConfig = thinkingConfig;
	}
	const body: JsonRecord = {
		contents: googleContents(request.messages),
	};
	if (request.system !== undefined) {
		body.systemInstruction = { parts: [{ text: request.system }] };
	}
	if (Object.keys(generationConfig).length > 0) {
		body.generationConfig = generationConfig;
	}
	const tools = request.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
	}));
	if (tools && tools.length > 0) {
		body.tools = [{ functionDeclarations: tools }];
	}
	return body;
};

export const googleStrategy = {
	protocol: "google",
	serialize: serializeGoogle,
	stream: googleStream,
} satisfies ModelProtocolStrategy<"google">;
