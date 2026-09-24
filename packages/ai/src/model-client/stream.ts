import { normalizeModelUsage } from "../model-usage";
import { ModelProviderError, providerEventError } from "./errors";
import type { ModelProtocol } from "./request";
import { readSseEvents } from "./sse";
import type { ModelStreamPart } from "./types";

type JsonRecord = Record<string, unknown>;
type SsePayload = Readonly<{ eventName?: string; value: JsonRecord }>;
const incompleteStreamError = (protocol: ModelProtocol): ModelProviderError =>
	new ModelProviderError(`${protocol} model stream ended before completion.`);

const record = (value: unknown): JsonRecord | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;

const stringValue = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const parseJsonValue = (value: unknown): unknown => {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
};

const payloadFrom = (
	data: string,
	eventName: string | undefined
): SsePayload | undefined => {
	try {
		const value = record(JSON.parse(data));
		return value ? { eventName, value } : undefined;
	} catch {
		return;
	}
};

const providerError = (
	payload: SsePayload,
	response: Response
): ModelProviderError | undefined => {
	const root = payload.value;
	if (
		payload.eventName === "response.failed" ||
		root.type === "response.failed"
	) {
		const responseBody = record(root.response);
		const failure = responseBody?.error ?? root.error;
		return providerEventError(
			{ error: failure ?? { message: "The model response failed." } },
			"error",
			response
		);
	}
	return providerEventError(root, payload.eventName, response);
};

const openAiUsage = (usageValue: unknown): unknown => {
	const usage = record(usageValue);
	if (!usage) {
		return;
	}
	const inputDetails = record(usage.input_tokens_details);
	const outputDetails = record(usage.output_tokens_details);
	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		totalTokens: usage.total_tokens,
		inputTokenDetails: inputDetails
			? { cacheReadTokens: inputDetails.cached_tokens }
			: undefined,
		outputTokenDetails: outputDetails
			? { reasoningTokens: outputDetails.reasoning_tokens }
			: undefined,
	};
};

type OpenAiResponseState = {
	completed: boolean;
	continuation: unknown;
	emittedToolCalls: Set<string>;
	usage: unknown;
};

const openAiResponseTextPart = (
	type: string | undefined,
	value: JsonRecord
): ModelStreamPart | undefined => {
	if (type === "response.output_text.delta") {
		const delta = stringValue(value.delta);
		return delta === undefined ? undefined : { type: "text-delta", delta };
	}
	if (
		type === "response.reasoning_summary_text.delta" ||
		type === "response.reasoning_text.delta"
	) {
		const delta = stringValue(value.delta);
		return delta === undefined ? undefined : { type: "reasoning-delta", delta };
	}
	return;
};

const openAiResponseToolPart = (
	type: string | undefined,
	value: JsonRecord,
	state: OpenAiResponseState
): ModelStreamPart | undefined => {
	let callId: string | undefined;
	let name: string | undefined;
	let input: unknown;
	if (type === "response.output_item.done") {
		const item = record(value.item);
		if (item?.type !== "function_call") {
			return;
		}
		callId = stringValue(item.call_id) ?? stringValue(item.id);
		name = stringValue(item.name);
		input = item.arguments;
	} else if (type === "response.function_call_arguments.done") {
		callId = stringValue(value.call_id);
		name = stringValue(value.name);
		input = value.arguments;
	} else {
		return;
	}
	if (!(callId && name) || state.emittedToolCalls.has(callId)) {
		return;
	}
	state.emittedToolCalls.add(callId);
	return {
		type: "tool-call",
		toolCallId: callId,
		toolName: name,
		input: parseJsonValue(input),
	};
};

const openAiResponseEventParts = function* (
	payload: SsePayload,
	response: Response,
	state: OpenAiResponseState
): Iterable<ModelStreamPart> {
	const error = providerError(payload, response);
	if (error) {
		throw error;
	}
	const value = payload.value;
	const type = stringValue(value.type) ?? payload.eventName;
	const textPart = openAiResponseTextPart(type, value);
	if (textPart) {
		yield textPart;
	}
	const toolPart = openAiResponseToolPart(type, value, state);
	if (toolPart) {
		yield toolPart;
	}
	if (type === "response.completed" || type === "response.incomplete") {
		const responseData = record(value.response);
		state.completed = true;
		state.continuation = Array.isArray(responseData?.output)
			? responseData.output
			: undefined;
		state.usage = openAiUsage(responseData?.usage ?? value.usage);
	}
};

const openAiResponseStream = async function* (
	response: Response,
	signal?: AbortSignal
): AsyncIterable<ModelStreamPart> {
	const state: OpenAiResponseState = {
		completed: false,
		continuation: undefined,
		emittedToolCalls: new Set<string>(),
		usage: undefined,
	};
	for await (const event of readSseEvents(
		response.body as ReadableStream<Uint8Array>,
		signal
	)) {
		if (event.data === "[DONE]") {
			state.completed = true;
			continue;
		}
		const payload = payloadFrom(event.data, event.event);
		if (!payload) {
			continue;
		}
		yield* openAiResponseEventParts(payload, response, state);
	}
	if (!state.completed) {
		throw incompleteStreamError("openai-responses");
	}
	const normalized = normalizeModelUsage(state.usage);
	yield {
		type: "finish",
		...(normalized ? { usage: normalized } : {}),
		...(state.continuation === undefined
			? {}
			: { continuation: state.continuation }),
	};
};

const anthropicUsage = (usageValue: unknown): unknown => {
	const usage = record(usageValue);
	if (!usage) {
		return;
	}
	return {
		...(usage.input_tokens === undefined
			? {}
			: { inputTokens: usage.input_tokens }),
		...(usage.output_tokens === undefined
			? {}
			: { outputTokens: usage.output_tokens }),
		...(usage.cache_read_input_tokens === undefined
			? {}
			: { cachedInputTokens: usage.cache_read_input_tokens }),
		...(usage.cache_creation_input_tokens === undefined
			? {}
			: {
					inputTokenDetails: {
						cacheWriteTokens: usage.cache_creation_input_tokens,
					},
				}),
	};
};

const mergeDefined = (previous: unknown, next: unknown): JsonRecord => {
	const merged = { ...(record(previous) ?? {}) };
	for (const [key, value] of Object.entries(record(next) ?? {})) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}
	return merged;
};

const updateTextBlock = (
	blocks: unknown[],
	index: number,
	key: string,
	value: string
): void => {
	const block = record(blocks[index]);
	if (block) {
		block[key] = `${stringValue(block[key]) ?? ""}${value}`;
	}
};

type AnthropicStreamState = {
	blocks: unknown[];
	completed: boolean;
	toolJsonByIndex: Map<number, string>;
	usage: unknown;
};

const anthropicContentBlockStart = function* (
	value: JsonRecord,
	state: AnthropicStreamState
): Iterable<ModelStreamPart> {
	if (typeof value.index !== "number") {
		return;
	}
	const block = record(value.content_block);
	if (!block) {
		return;
	}
	state.blocks[value.index] = { ...block };
	const initialText = stringValue(block.text);
	if (block.type === "text" && initialText && initialText.length > 0) {
		yield { type: "text-delta", delta: initialText };
	}
	const initialThinking = stringValue(block.thinking);
	if (
		block.type === "thinking" &&
		initialThinking &&
		initialThinking.length > 0
	) {
		yield { type: "reasoning-delta", delta: initialThinking };
	}
	if (block.type === "tool_use") {
		state.toolJsonByIndex.set(value.index, "");
	}
};

const anthropicContentBlockDelta = function* (
	value: JsonRecord,
	state: AnthropicStreamState
): Iterable<ModelStreamPart> {
	if (typeof value.index !== "number") {
		return;
	}
	const delta = record(value.delta);
	if (!delta) {
		return;
	}
	if (delta.type === "text_delta") {
		const text = stringValue(delta.text);
		if (text !== undefined) {
			updateTextBlock(state.blocks, value.index, "text", text);
			yield { type: "text-delta", delta: text };
		}
	} else if (delta.type === "thinking_delta") {
		const text = stringValue(delta.thinking);
		if (text !== undefined) {
			updateTextBlock(state.blocks, value.index, "thinking", text);
			yield { type: "reasoning-delta", delta: text };
		}
	} else if (delta.type === "signature_delta") {
		const signature = stringValue(delta.signature);
		if (signature !== undefined) {
			updateTextBlock(state.blocks, value.index, "signature", signature);
		}
	} else if (delta.type === "input_json_delta") {
		const partial = stringValue(delta.partial_json);
		if (partial !== undefined) {
			state.toolJsonByIndex.set(
				value.index,
				`${state.toolJsonByIndex.get(value.index) ?? ""}${partial}`
			);
		}
	}
};

const anthropicContentBlockStop = (
	value: JsonRecord,
	state: AnthropicStreamState
): ModelStreamPart | undefined => {
	if (typeof value.index !== "number") {
		return;
	}
	const block = record(state.blocks[value.index]);
	if (block?.type !== "tool_use") {
		return;
	}
	const toolCallId = stringValue(block.id);
	const toolName = stringValue(block.name);
	const json = state.toolJsonByIndex.get(value.index);
	let input = block.input;
	if (json) {
		try {
			input = JSON.parse(json) as unknown;
			block.input = input;
		} catch {
			input = block.input;
		}
	}
	if (toolCallId && toolName) {
		return { type: "tool-call", toolCallId, toolName, input };
	}
	return;
};

const anthropicEventParts = function* (
	payload: SsePayload,
	response: Response,
	state: AnthropicStreamState
): Iterable<ModelStreamPart> {
	const error = providerError(payload, response);
	if (error) {
		throw error;
	}
	const value = payload.value;
	const type = stringValue(value.type) ?? payload.eventName;
	if (type === "message_stop") {
		state.completed = true;
	} else if (type === "message_start") {
		const message = record(value.message);
		state.usage = anthropicUsage(message?.usage);
	} else if (type === "content_block_start") {
		yield* anthropicContentBlockStart(value, state);
	} else if (type === "content_block_delta") {
		yield* anthropicContentBlockDelta(value, state);
	} else if (type === "content_block_stop") {
		const part = anthropicContentBlockStop(value, state);
		if (part) {
			yield part;
		}
	} else if (type === "message_delta") {
		const usageUpdate = anthropicUsage(value.usage);
		if (usageUpdate) {
			state.usage = mergeDefined(state.usage, usageUpdate);
		}
	}
};

const anthropicStream = async function* (
	response: Response,
	signal?: AbortSignal
): AsyncIterable<ModelStreamPart> {
	const state: AnthropicStreamState = {
		blocks: [],
		completed: false,
		toolJsonByIndex: new Map<number, string>(),
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
		yield* anthropicEventParts(payload, response, state);
	}
	if (!state.completed) {
		throw incompleteStreamError("anthropic");
	}
	const normalized = normalizeModelUsage(state.usage);
	const continuation = state.blocks.filter((block) => block !== undefined);
	yield {
		type: "finish",
		...(normalized ? { usage: normalized } : {}),
		...(continuation.length > 0 ? { continuation } : {}),
	};
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

type ChatToolCall = {
	arguments: string;
	id?: string;
	name: string;
};

const chatUsage = (usageValue: unknown): unknown => {
	const usage = record(usageValue);
	if (!usage) {
		return;
	}
	const promptDetails = record(usage.prompt_tokens_details);
	const completionDetails = record(usage.completion_tokens_details);
	return {
		inputTokens: usage.prompt_tokens,
		outputTokens: usage.completion_tokens,
		totalTokens: usage.total_tokens,
		inputTokenDetails: { cacheReadTokens: promptDetails?.cached_tokens },
		outputTokenDetails: {
			reasoningTokens: completionDetails?.reasoning_tokens,
		},
	};
};

const deltaText = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		return value;
	}
	if (!Array.isArray(value)) {
		return;
	}
	return value.map((part) => stringValue(record(part)?.text) ?? "").join("");
};

type OpenAiChatState = {
	completed: boolean;
	emittedToolCalls: Set<number>;
	toolCalls: Map<number, ChatToolCall>;
	usage: unknown;
};

const flushOpenAiChatToolCalls = function* (
	state: OpenAiChatState
): Iterable<ModelStreamPart> {
	for (const [index, tool] of state.toolCalls) {
		if (state.emittedToolCalls.has(index)) {
			continue;
		}
		if (tool.name.length === 0) {
			continue;
		}
		state.emittedToolCalls.add(index);
		yield {
			type: "tool-call",
			toolCallId: tool.id ?? `tool-${index}`,
			toolName: tool.name,
			input: parseJsonValue(tool.arguments),
		};
	}
};

const accumulateOpenAiChatToolCall = (
	valueCall: unknown,
	fallbackIndex: number,
	state: OpenAiChatState
): void => {
	const call = record(valueCall);
	const functionCall = record(call?.function);
	if (!(call && functionCall)) {
		return;
	}
	const index = typeof call.index === "number" ? call.index : fallbackIndex;
	const current = state.toolCalls.get(index) ?? {
		arguments: "",
		name: "",
	};
	current.id = stringValue(call.id) ?? current.id;
	current.name += stringValue(functionCall.name) ?? "";
	current.arguments += stringValue(functionCall.arguments) ?? "";
	state.toolCalls.set(index, current);
};

const accumulateOpenAiChatToolCalls = (
	value: unknown,
	state: OpenAiChatState
): void => {
	if (!Array.isArray(value)) {
		return;
	}
	for (const [fallbackIndex, valueCall] of value.entries()) {
		accumulateOpenAiChatToolCall(valueCall, fallbackIndex, state);
	}
};

const openAiChatChoiceParts = function* (
	valueChoice: unknown,
	state: OpenAiChatState
): Iterable<ModelStreamPart> {
	const choice = record(valueChoice);
	if (!choice) {
		return;
	}
	const delta = record(choice.delta);
	if (delta) {
		const text = deltaText(delta.content);
		if (text) {
			yield { type: "text-delta", delta: text };
		}
		const reasoning =
			deltaText(delta.reasoning_content) ??
			deltaText(delta.reasoning) ??
			deltaText(delta.thinking);
		if (reasoning) {
			yield { type: "reasoning-delta", delta: reasoning };
		}
		accumulateOpenAiChatToolCalls(delta.tool_calls, state);
	}
	if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
		state.completed = true;
		yield* flushOpenAiChatToolCalls(state);
	}
};

const openAiChatEventParts = function* (
	payload: SsePayload,
	response: Response,
	state: OpenAiChatState
): Iterable<ModelStreamPart> {
	const error = providerError(payload, response);
	if (error) {
		throw error;
	}
	const value = payload.value;
	const choices = Array.isArray(value.choices) ? value.choices : [];
	for (const valueChoice of choices) {
		yield* openAiChatChoiceParts(valueChoice, state);
	}
	state.usage = chatUsage(value.usage) ?? state.usage;
};

const openAiChatStream = async function* (
	response: Response,
	signal?: AbortSignal
): AsyncIterable<ModelStreamPart> {
	const state: OpenAiChatState = {
		completed: false,
		emittedToolCalls: new Set<number>(),
		toolCalls: new Map<number, ChatToolCall>(),
		usage: undefined,
	};
	for await (const event of readSseEvents(
		response.body as ReadableStream<Uint8Array>,
		signal
	)) {
		if (event.data === "[DONE]") {
			state.completed = true;
			continue;
		}
		const payload = payloadFrom(event.data, event.event);
		if (!payload) {
			continue;
		}
		yield* openAiChatEventParts(payload, response, state);
	}
	if (!state.completed) {
		throw incompleteStreamError("openai-chat");
	}
	yield* flushOpenAiChatToolCalls(state);
	const normalized = normalizeModelUsage(state.usage);
	yield normalized ? { type: "finish", usage: normalized } : { type: "finish" };
};

export const streamProviderResponse = (
	protocol: ModelProtocol,
	response: Response,
	signal?: AbortSignal
): AsyncIterable<ModelStreamPart> => {
	if (!response.body) {
		throw new Error("Model provider returned an empty response stream.");
	}
	switch (protocol) {
		case "openai-responses":
			return openAiResponseStream(response, signal);
		case "anthropic":
			return anthropicStream(response, signal);
		case "google":
			return googleStream(response, signal);
		case "openai-chat":
			return openAiChatStream(response, signal);
		default:
			throw new Error(`Unsupported model protocol: ${protocol}`);
	}
};
