import { isNonNegativeInteger } from "@wincode/utils";
import type { SupportedPromptCacheRetentionTier } from "../../model-metadata";
import { MODEL_OUTPUT_TOKEN_LIMIT } from "../../model-output-limit.ts";
import { normalizeModelUsage } from "../../model-usage.ts";
import type { ProviderModel } from "../../sdk.ts";
import { readSseEvents } from "../sse.ts";
import {
	type AnthropicModelMetadataLookup,
	createAnthropicPromptCacheStrategy,
} from "./anthropic-prompt-cache.ts";
import type {
	ProtocolPromptMessage,
	ProtocolPromptPart,
	ProtocolStreamPart,
} from "./request.ts";
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
} from "./shared.ts";
import type {
	ModelProtocolStrategy,
	ProviderProtocolRequestContextByProtocol,
} from "./types";

const anthropicContent = (
	content: readonly ProtocolPromptPart[]
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
	message: ProtocolPromptMessage
): JsonRecord | undefined => {
	if (message.role === "assistant" && Array.isArray(message.continuation)) {
		return { role: "assistant", content: message.continuation };
	}
	const role = message.role === "assistant" ? "assistant" : "user";
	const blocks = anthropicContent(message.content);
	return blocks.length > 0 ? { role, content: blocks } : undefined;
};

const withAnthropicCacheControl = (
	blocks: readonly unknown[],
	cacheControl: JsonRecord
): unknown[] => {
	const blockIndex = blocks.findLastIndex((value) => {
		const block = record(value);
		return (
			block !== undefined &&
			block.type !== "thinking" &&
			!(block.type === "text" && block.text === "")
		);
	});
	return blockIndex < 0
		? [...blocks]
		: blocks.map((value, index) =>
				index === blockIndex
					? { ...record(value), cache_control: cacheControl }
					: value
			);
};

const anthropicMessages = (
	messages: readonly ProtocolPromptMessage[],
	cacheControl: JsonRecord | undefined
): JsonRecord[] => {
	const result: JsonRecord[] = [];
	const lastMessageIndex = messages.length - 1;
	const stablePrefixIndex =
		messages[lastMessageIndex]?.role === "user"
			? lastMessageIndex - 1
			: lastMessageIndex;
	for (const [index, message] of messages.entries()) {
		const converted = anthropicMessage(message);
		if (converted) {
			const content = converted.content;
			result.push(
				cacheControl && index === stablePrefixIndex && Array.isArray(content)
					? {
							...converted,
							content: withAnthropicCacheControl(content, cacheControl),
						}
					: converted
			);
		}
	}
	return result;
};
const anthropicUsage = (usageValue: unknown): unknown => {
	const usage = record(usageValue);
	if (!usage) {
		return;
	}
	const inputTokens = usage.input_tokens;
	const cacheReadTokens = usage.cache_read_input_tokens;
	const cacheWriteTokens = usage.cache_creation_input_tokens;
	const totalInputTokens = isNonNegativeInteger(inputTokens)
		? inputTokens +
			(isNonNegativeInteger(cacheReadTokens) ? cacheReadTokens : 0) +
			(isNonNegativeInteger(cacheWriteTokens) ? cacheWriteTokens : 0)
		: inputTokens;
	return {
		...(inputTokens === undefined ? {} : { inputTokens: totalInputTokens }),
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
): Iterable<ProtocolStreamPart> {
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
): Iterable<ProtocolStreamPart> {
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
): ProtocolStreamPart | undefined => {
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
): Iterable<ProtocolStreamPart> {
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
): AsyncIterable<ProtocolStreamPart> {
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
const anthropicCacheControl = (
	model: ProviderModel,
	retention: SupportedPromptCacheRetentionTier | undefined,
	promptCache: ModelProtocolStrategy<"anthropic">["promptCache"]
): JsonRecord | undefined => {
	if (
		retention === undefined ||
		!promptCache.routeForModel(model)?.isRetentionSupported(retention)
	) {
		return;
	}
	return {
		type: "ephemeral",
		...(retention === "long" ? { ttl: "1h" } : {}),
	};
};

const serializeAnthropic = (
	context: ProviderProtocolRequestContextByProtocol["anthropic"],
	modelMetadataFor: AnthropicModelMetadataLookup,
	promptCache: ModelProtocolStrategy<"anthropic">["promptCache"]
): JsonRecord => {
	const { request, model, maxOutputTokens, providerOptions } = context;
	const cacheControl = anthropicCacheControl(
		model,
		request.promptCacheRetention,
		promptCache
	);
	const thinking = providerOptions?.thinking;
	const body: JsonRecord = {
		model: request.modelId,
		max_tokens:
			maxOutputTokens ??
			modelMetadataFor(model)?.limits?.output ??
			MODEL_OUTPUT_TOKEN_LIMIT,
		messages: anthropicMessages(request.messages, cacheControl),
		stream: true,
	};
	if (request.system !== undefined) {
		body.system = cacheControl
			? withAnthropicCacheControl(
					[{ type: "text", text: request.system }],
					cacheControl
				)
			: request.system;
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
	const tools: JsonRecord[] =
		request.tools?.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema,
		})) ?? [];
	if (tools.length > 0) {
		if (cacheControl) {
			tools[tools.length - 1] = {
				...tools.at(-1),
				cache_control: cacheControl,
			};
		}
		body.tools = tools;
	}
	return body;
};

export const createAnthropicStrategy = (
	modelMetadataFor: AnthropicModelMetadataLookup
): ModelProtocolStrategy<"anthropic"> => {
	const promptCache = createAnthropicPromptCacheStrategy(modelMetadataFor);
	return {
		protocol: "anthropic",
		promptCache,
		serialize: (context) =>
			serializeAnthropic(context, modelMetadataFor, promptCache),
		stream: anthropicStream,
	};
};
