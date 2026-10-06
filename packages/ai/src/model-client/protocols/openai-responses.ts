import { isObjectLike } from "@wincode/utils";
import { normalizeModelUsage } from "../../model-usage";
import { readSseEvents } from "../sse";
import type {
	ModelPromptMessage,
	ModelPromptPart,
	ModelStreamPart,
} from "../types";
import type { JsonRecord, SsePayload } from "./shared";
import {
	fileDataUri,
	incompleteStreamError,
	parseJsonValue,
	payloadFrom,
	providerError,
	record,
	stringValue,
	unknownArray,
	unreachableValue,
	valueAsText,
} from "./shared";
import type {
	ModelProtocolStrategy,
	ProtocolRequestContextByProtocol,
} from "./types";

type ResponsesInputItem = Readonly<Record<string, unknown>>;

type ResponsesFunctionCallItem = ResponsesInputItem &
	Readonly<{
		arguments: string;
		call_id: string;
		name: string;
		type: "function_call";
	}>;

/** Keeps provider items authoritative and appends each missing local call once, by call_id. */
const reconcileResponsesContinuation = (
	continuation: readonly unknown[],
	toolCalls: readonly ResponsesFunctionCallItem[]
): readonly unknown[] => {
	const knownCallIds = new Set<string>();
	for (const candidate of continuation) {
		if (!isObjectLike(candidate) || Array.isArray(candidate)) {
			continue;
		}
		if (
			candidate.type === "function_call" &&
			typeof candidate.call_id === "string"
		) {
			knownCallIds.add(candidate.call_id);
		}
	}

	const inputItems: unknown[] = [...continuation];
	for (const toolCall of toolCalls) {
		if (knownCallIds.has(toolCall.call_id)) {
			continue;
		}
		knownCallIds.add(toolCall.call_id);
		inputItems.push(toolCall);
	}
	return inputItems;
};

const openAiMessagePart = (
	role: "assistant" | "user",
	part: ModelPromptPart
): JsonRecord | undefined => {
	switch (part.type) {
		case "text":
			return {
				type: role === "assistant" ? "output_text" : "input_text",
				text: part.text,
			};
		case "file": {
			const data = fileDataUri(part.mediaType, part.data);
			return part.mediaType.startsWith("image/")
				? { type: "input_image", image_url: data }
				: {
						type: "input_file",
						file_data: data,
						filename: "attachment",
					};
		}
		case "tool-call":
		case "tool-result":
		case "tool-failure":
			return;
		default:
			return unreachableValue(part);
	}
};

const openAiMessageContent = (
	role: "assistant" | "user",
	content: readonly ModelPromptPart[]
): JsonRecord[] => {
	const result: JsonRecord[] = [];
	for (const part of content) {
		const converted = openAiMessagePart(role, part);
		if (converted) {
			result.push(converted);
		}
	}
	return result;
};

const appendOpenAiResponsesToolPart = (
	input: unknown[],
	part: ModelPromptPart
): void => {
	switch (part.type) {
		case "tool-result":
			input.push({
				call_id: part.toolCallId,
				output: valueAsText(part.output),
				type: "function_call_output",
			});
			return;
		case "tool-failure":
			input.push({
				call_id: part.toolCallId,
				output: part.errorText,
				type: "function_call_output",
			});
			return;
		case "text":
		case "file":
		case "tool-call":
			return;
		default:
			unreachableValue(part);
	}
};

const appendOpenAiResponsesToolResults = (
	input: unknown[],
	content: readonly ModelPromptPart[]
): void => {
	for (const part of content) {
		appendOpenAiResponsesToolPart(input, part);
	}
};

const openAiResponsesFunctionCall = (
	part: Extract<ModelPromptPart, { type: "tool-call" }>
): ResponsesFunctionCallItem => ({
	arguments: valueAsText(part.input),
	call_id: part.toolCallId,
	name: part.toolName,
	type: "function_call",
});

const appendOpenAiResponsesToolCalls = (
	input: unknown[],
	content: readonly ModelPromptPart[],
	continuation?: readonly unknown[]
): void => {
	const toolCalls: ResponsesFunctionCallItem[] | undefined =
		continuation === undefined ? undefined : [];
	for (const part of content) {
		if (part.type !== "tool-call") {
			continue;
		}
		const toolCall = openAiResponsesFunctionCall(part);
		if (toolCalls === undefined) {
			input.push(toolCall);
		} else {
			toolCalls.push(toolCall);
		}
	}

	if (continuation === undefined || toolCalls === undefined) {
		return;
	}
	for (const item of reconcileResponsesContinuation(continuation, toolCalls)) {
		input.push(item);
	}
};

const appendOpenAiResponsesMessage = (
	input: unknown[],
	message: ModelPromptMessage
): void => {
	if (message.role === "tool") {
		appendOpenAiResponsesToolResults(input, message.content);
		return;
	}
	const continuation = unknownArray(message.continuation);
	if (message.role === "assistant" && continuation) {
		appendOpenAiResponsesToolCalls(input, message.content, continuation);
		return;
	}

	const content = openAiMessageContent(message.role, message.content);
	if (content.length > 0) {
		input.push({ content, role: message.role, type: "message" });
	}
	if (message.role === "assistant") {
		appendOpenAiResponsesToolCalls(input, message.content);
	}
};

const openAiResponsesInput = (
	messages: readonly ModelPromptMessage[]
): unknown[] => {
	const input: unknown[] = [];
	for (const message of messages) {
		appendOpenAiResponsesMessage(input, message);
	}
	return input;
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
const serializeOpenAIResponses = (
	context: ProtocolRequestContextByProtocol["openai-responses"]
): JsonRecord => {
	const { request, maxOutputTokens, providerOptions } = context;
	const body: JsonRecord = {
		model: request.target.modelId,
		input: openAiResponsesInput(request.messages),
		stream: true,
	};
	if (request.system !== undefined) {
		body.instructions = request.system;
	}
	if (!context.omitOutputTokenLimit && maxOutputTokens !== undefined) {
		body.max_output_tokens = maxOutputTokens;
	}
	if (providerOptions?.store !== undefined) {
		body.store = providerOptions.store;
	}
	const effort = providerOptions?.reasoningEffort;
	const summary = providerOptions?.reasoningSummary;
	if (effort !== undefined || summary !== undefined) {
		body.reasoning = {
			...(effort === undefined ? {} : { effort }),
			...(summary === undefined ? {} : { summary }),
		};
	}
	const tools = request.tools?.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
	}));
	if (tools && tools.length > 0) {
		body.tools = tools;
	}
	return body;
};

export const openAIResponsesStrategy = {
	protocol: "openai-responses",
	serialize: serializeOpenAIResponses,
	stream: openAiResponseStream,
} satisfies ModelProtocolStrategy<"openai-responses">;
