import { getModelMetadata } from "../../model-metadata-runtime";
import { MODEL_OUTPUT_TOKEN_LIMIT } from "../../model-provider-options";
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
	valueAsText,
} from "./shared";
import type {
	ModelProtocolStrategy,
	ProtocolRequestContextByProtocol,
} from "./types";

const anthropicContent = (
	content: readonly ModelPromptPart[]
): JsonRecord[] => {
	const result: JsonRecord[] = [];
	for (const part of content) {
		switch (part.type) {
			case "text":
				result.push({ type: "text", text: part.text });
				break;
			case "file": {
				const source = {
					type: "base64",
					media_type: part.mediaType,
					data: base64(part.data),
				};
				result.push(
					part.mediaType.startsWith("image/")
						? { type: "image", source }
						: { type: "document", source }
				);
				break;
			}
			case "tool-call":
				result.push({
					type: "tool_use",
					id: part.toolCallId,
					name: part.toolName,
					input: part.input,
				});
				break;
			case "tool-result":
				result.push({
					type: "tool_result",
					tool_use_id: part.toolCallId,
					content: valueAsText(part.output),
				});
				break;
			case "tool-failure":
				result.push({
					type: "tool_result",
					tool_use_id: part.toolCallId,
					content: part.errorText,
					is_error: true,
				});
				break;
			default:
				unreachableValue(part);
		}
	}
	return result;
};

const anthropicMessage = (
	message: ModelPromptMessage
): JsonRecord | undefined => {
	if (message.role === "assistant" && Array.isArray(message.continuation)) {
		return { role: "assistant", content: message.continuation };
	}
	const role = message.role === "assistant" ? "assistant" : "user";
	const blocks = anthropicContent(message.content);
	return blocks.length > 0 ? { role, content: blocks } : undefined;
};

const anthropicMessages = (
	messages: readonly ModelPromptMessage[]
): JsonRecord[] => {
	const result: JsonRecord[] = [];
	for (const message of messages) {
		const converted = anthropicMessage(message);
		if (converted) {
			result.push(converted);
		}
	}
	return result;
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
const serializeAnthropic = (
	context: ProtocolRequestContextByProtocol["anthropic"]
): JsonRecord => {
	const { request, model, maxOutputTokens, providerOptions } = context;
	const thinking = providerOptions?.thinking;
	const body: JsonRecord = {
		model: request.target.modelId,
		max_tokens:
			maxOutputTokens ??
			getModelMetadata(model)?.limits?.output ??
			MODEL_OUTPUT_TOKEN_LIMIT,
		messages: anthropicMessages(request.messages),
		stream: true,
	};
	if (request.system !== undefined) {
		body.system = request.system;
	}
	if (providerOptions?.effort !== undefined) {
		body.output_config = { effort: providerOptions.effort };
	}
	if (thinking && thinking.type !== "disabled") {
		body.thinking = {
			type: thinking.type,
			...(thinking.type === "enabled"
				? { budget_tokens: thinking.budgetTokens }
				: {}),
		};
	}
	const tools = request.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema,
	}));
	if (tools && tools.length > 0) {
		body.tools = tools;
	}
	return body;
};

export const anthropicStrategy = {
	protocol: "anthropic",
	serialize: serializeAnthropic,
	stream: anthropicStream,
} satisfies ModelProtocolStrategy<"anthropic">;
