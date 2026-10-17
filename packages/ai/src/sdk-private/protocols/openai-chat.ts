import { normalizeModelUsage } from "../../model-usage.ts";
import { readSseEvents } from "../sse.ts";
import {
	openAIPromptCacheControlsForRequest,
	openAIPromptCacheStrategyFor,
} from "./openai-prompt-cache.ts";
import { openAIProtocolReasoningEffortFor } from "./provider-options.ts";
import type {
	ProtocolPromptMessage,
	ProtocolPromptPart,
	ProtocolStreamPart,
	ProviderProtocolRequest,
} from "./request.ts";
import {
	fileDataUri,
	incompleteStreamError,
	type JsonRecord,
	parseJsonValue,
	payloadFrom,
	providerError,
	record,
	type SsePayload,
	stringValue,
	unreachableValue,
	valueAsText,
} from "./shared.ts";
import type {
	ModelProtocolStrategy,
	ProviderProtocolRequestContextByProtocol,
} from "./types.ts";

const appendChatCompletionsPart = (
	part: ProtocolPromptPart,
	chunks: JsonRecord[],
	text: string[]
): boolean => {
	switch (part.type) {
		case "text":
			text.push(part.text);
			chunks.push({ type: "text", text: part.text });
			return false;
		case "file": {
			const data = fileDataUri(part.mediaType, part.data);
			chunks.push(
				part.mediaType.startsWith("image/")
					? { type: "image_url", image_url: { url: data } }
					: {
							type: "file",
							file: { filename: "attachment", file_data: data },
						}
			);
			return true;
		}
		case "tool-call":
		case "tool-result":
		case "tool-failure":
			return false;
		default:
			return unreachableValue(part);
	}
};

const chatCompletionsContent = (
	content: readonly ProtocolPromptPart[]
): string | JsonRecord[] => {
	const chunks: JsonRecord[] = [];
	const text: string[] = [];
	let hasFile = false;
	for (const part of content) {
		hasFile = appendChatCompletionsPart(part, chunks, text) || hasFile;
	}
	return hasFile ? chunks : text.join("");
};

const appendChatCompletionsToolMessage = (
	result: JsonRecord[],
	part: ProtocolPromptPart
): void => {
	switch (part.type) {
		case "tool-result":
			result.push({
				role: "tool",
				tool_call_id: part.toolCallId,
				content: valueAsText(part.output),
			});
			return;
		case "tool-failure":
			result.push({
				role: "tool",
				tool_call_id: part.toolCallId,
				content: part.errorText,
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

const appendChatCompletionsToolMessages = (
	result: JsonRecord[],
	content: readonly ProtocolPromptPart[]
): void => {
	for (const part of content) {
		appendChatCompletionsToolMessage(result, part);
	}
};

const chatCompletionsToolCalls = (
	content: readonly ProtocolPromptPart[]
): JsonRecord[] => {
	const toolCalls: JsonRecord[] = [];
	for (const part of content) {
		if (part.type === "tool-call") {
			toolCalls.push({
				id: part.toolCallId,
				type: "function",
				function: {
					name: part.toolName,
					arguments: valueAsText(part.input),
				},
			});
		}
	}
	return toolCalls;
};

const appendChatCompletionsMessage = (
	result: JsonRecord[],
	message: ProtocolPromptMessage
): void => {
	if (message.role === "tool") {
		appendChatCompletionsToolMessages(result, message.content);
		return;
	}
	const toolCalls = chatCompletionsToolCalls(message.content);
	const content = chatCompletionsContent(message.content);
	if (content !== "" || toolCalls.length > 0) {
		result.push({
			role: message.role,
			content: content === "" && toolCalls.length > 0 ? null : content,
			...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		});
	}
};

const chatCompletionsMessages = (
	messages: readonly ProtocolPromptMessage[],
	system: string | undefined
): JsonRecord[] => {
	const result: JsonRecord[] = [];
	if (system !== undefined) {
		result.push({ role: "system", content: system });
	}
	for (const message of messages) {
		appendChatCompletionsMessage(result, message);
	}
	return result;
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
		inputTokenDetails: {
			cacheReadTokens: promptDetails?.cached_tokens,
			cacheWriteTokens: promptDetails?.cache_write_tokens,
		},
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
): Iterable<ProtocolStreamPart> {
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
): Iterable<ProtocolStreamPart> {
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
): Iterable<ProtocolStreamPart> {
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
): AsyncIterable<ProtocolStreamPart> {
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
export type OpenAICompatibleChatRequest = Readonly<{
	maxOutputTokens?: number;
	messages: readonly ProtocolPromptMessage[];
	modelId: string;
	reasoningEffort?: ProviderProtocolRequest["reasoningEffort"];
	system?: string;
	tools?: readonly Readonly<{
		description?: string;
		inputSchema: Readonly<Record<string, unknown>>;
		name: string;
	}>[];
}>;

const serializeOpenAICompatibleChat = (
	request: OpenAICompatibleChatRequest
): JsonRecord => {
	const body: JsonRecord = {
		model: request.modelId,
		messages: chatCompletionsMessages(request.messages, request.system),
		stream: true,
		stream_options: { include_usage: true },
	};
	if (request.maxOutputTokens !== undefined) {
		body.max_tokens = request.maxOutputTokens;
	}
	if (request.reasoningEffort !== undefined) {
		body.reasoning_effort = openAIProtocolReasoningEffortFor(
			request.reasoningEffort
		);
	}
	const tools = request.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		},
	}));
	if (tools && tools.length > 0) {
		body.tools = tools;
	}
	return body;
};

const serializeOpenAIChat = (
	context: ProviderProtocolRequestContextByProtocol["openai-chat"]
): JsonRecord => {
	const { request, maxOutputTokens, model } = context;
	const cacheControls = openAIPromptCacheControlsForRequest(
		model,
		"openai-chat",
		request,
		request.promptCacheKey
	);
	const body = serializeOpenAICompatibleChat({
		maxOutputTokens,
		messages: request.messages,
		modelId: request.modelId,
		reasoningEffort: request.reasoningEffort,
		system: request.system,
		tools: request.tools,
	});
	if (cacheControls.promptCacheKey !== undefined) {
		body.prompt_cache_key = cacheControls.promptCacheKey;
	}
	if (cacheControls.retentionField === "prompt_cache_retention") {
		body.prompt_cache_retention = cacheControls.retentionValue;
	} else if (cacheControls.retentionField === "prompt_cache_options.ttl") {
		body.prompt_cache_options = { ttl: cacheControls.retentionValue };
	}
	return body;
};

export const openAICompatibleChatProtocol = {
	protocol: "openai-compatible",
	serialize: serializeOpenAICompatibleChat,
	stream: openAiChatStream,
};

export const openAIChatStrategy = {
	protocol: "openai-chat",
	promptCache: openAIPromptCacheStrategyFor("openai-chat"),
	serialize: serializeOpenAIChat,
	stream: openAiChatStream,
} satisfies ModelProtocolStrategy<"openai-chat">;
