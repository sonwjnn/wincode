import { getModelMetadata } from "../model-metadata-runtime";
import {
	MODEL_OUTPUT_TOKEN_LIMIT,
	type ModelProviderOptions,
	resolveModelProviderOptions,
} from "../model-provider-options";
import type { SupportedChatModel } from "../models";
import type {
	ModelPromptMessage,
	ModelPromptPart,
	ModelStepRequest,
	ModelTool,
} from "./types";

export type ModelProtocol =
	| "anthropic"
	| "google"
	| "openai-chat"
	| "openai-responses";

export type ProviderRequest = Readonly<{
	init: Omit<RequestInit, "signal">;
	protocol: ModelProtocol;
	url: string;
}>;

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
const unknownArray = (value: unknown): readonly unknown[] | undefined =>
	Array.isArray(value) ? value : undefined;

const base64 = (data: string | Uint8Array): string => {
	if (typeof data === "string") {
		const comma = data.startsWith("data:") ? data.indexOf(",") : -1;
		return comma === -1 ? data : data.slice(comma + 1);
	}
	let binary = "";
	for (let offset = 0; offset < data.length; offset += 0x80_00) {
		binary += String.fromCharCode(...data.subarray(offset, offset + 0x80_00));
	}
	return btoa(binary);
};

const fileDataUri = (mediaType: string, data: string | Uint8Array): string =>
	typeof data === "string" && data.startsWith("data:")
		? data
		: `data:${mediaType};base64,${base64(data)}`;

const valueAsText = (value: unknown): string =>
	typeof value === "string" ? value : (JSON.stringify(value) ?? "");

const unreachableValue = (value: never): never => {
	throw new Error(`Unexpected value: ${String(value)}`);
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

const appendOpenAiResponsesToolCalls = (
	input: unknown[],
	content: readonly ModelPromptPart[]
): void => {
	for (const part of content) {
		if (part.type === "tool-call") {
			input.push({
				arguments: valueAsText(part.input),
				call_id: part.toolCallId,
				name: part.toolName,
				type: "function_call",
			});
		}
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
		for (const item of continuation) {
			input.push(item);
		}
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

const appendChatCompletionsPart = (
	part: ModelPromptPart,
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
	content: readonly ModelPromptPart[]
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
	part: ModelPromptPart
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
	content: readonly ModelPromptPart[]
): void => {
	for (const part of content) {
		appendChatCompletionsToolMessage(result, part);
	}
};

const chatCompletionsToolCalls = (
	content: readonly ModelPromptPart[]
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
	message: ModelPromptMessage
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
	messages: readonly ModelPromptMessage[],
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

const toolSchemas = (
	tools: readonly ModelTool[] | undefined,
	protocol: ModelProtocol
): JsonRecord[] | undefined => {
	if (!tools || tools.length === 0) {
		return;
	}
	switch (protocol) {
		case "openai-responses":
			return tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
			}));
		case "openai-chat":
			return tools.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.inputSchema,
				},
			}));
		case "anthropic":
			return tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.inputSchema,
			}));
		case "google":
			return [
				{
					functionDeclarations: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.inputSchema,
					})),
				},
			];
		default:
			return unreachableValue(protocol);
	}
};

const mergeProviderOptions = (
	resolved: ModelProviderOptions | undefined,
	target: ModelProviderOptions | undefined
): ModelProviderOptions | undefined => {
	if (!resolved) {
		return target;
	}
	if (!target) {
		return resolved;
	}
	if ("openai" in resolved && "openai" in target) {
		return { openai: { ...resolved.openai, ...target.openai } };
	}
	if ("anthropic" in resolved && "anthropic" in target) {
		return { anthropic: { ...resolved.anthropic, ...target.anthropic } };
	}
	if ("google" in resolved && "google" in target) {
		return {
			google: {
				thinkingConfig: {
					...resolved.google.thinkingConfig,
					...target.google.thinkingConfig,
				},
			},
		};
	}
	return target;
};

const providerOptionsFor = (
	model: SupportedChatModel,
	providerOptions: ModelProviderOptions | undefined
): JsonRecord | undefined => {
	if (!providerOptions) {
		return;
	}
	if (model.provider === "opencode-go") {
		if (model.protocol === "openai" && "openai" in providerOptions) {
			return providerOptions.openai as JsonRecord;
		}
		if (model.protocol === "anthropic" && "anthropic" in providerOptions) {
			return providerOptions.anthropic as JsonRecord;
		}
		return;
	}
	if (model.provider === "openai" && "openai" in providerOptions) {
		return providerOptions.openai as JsonRecord;
	}
	if (model.provider === "anthropic" && "anthropic" in providerOptions) {
		return providerOptions.anthropic as JsonRecord;
	}
	if (model.provider === "google" && "google" in providerOptions) {
		return providerOptions.google as JsonRecord;
	}
	return;
};

type ProviderRequestContext = Readonly<{
	apiKey: string | undefined;
	commonHeaders: Readonly<{ "content-type": string }>;
	maxOutputTokens: number | undefined;
	model: SupportedChatModel;
	optionValues: JsonRecord | undefined;
	request: ModelStepRequest;
}>;

type OpenCodeGoModel = Extract<
	SupportedChatModel,
	{ readonly provider: "opencode-go" }
>;

const providerRequestContext = (
	request: ModelStepRequest,
	model: SupportedChatModel
): ProviderRequestContext => {
	const { target } = request;
	const resolved = resolveModelProviderOptions(model, {
		maxOutputTokens: target.maxOutputTokens,
		variant: target.variant,
	});
	const maxOutputTokens = resolved.maxOutputTokens ?? target.maxOutputTokens;
	const providerOptions = mergeProviderOptions(
		resolved.providerOptions,
		target.providerOptions
	);
	const optionValues = providerOptionsFor(model, providerOptions);
	const authorization = target.authorization;
	const apiKey =
		authorization.kind === "api-key" ? authorization.apiKey : undefined;
	return {
		apiKey,
		commonHeaders: { "content-type": "application/json" },
		maxOutputTokens,
		model,
		optionValues,
		request,
	};
};

const openAiResponsesRequest = (
	context: ProviderRequestContext
): ProviderRequest => {
	const {
		apiKey,
		commonHeaders,
		maxOutputTokens,
		model,
		optionValues,
		request,
	} = context;
	const { target } = request;
	const auth = target.authorization;
	const isGo = model.provider === "opencode-go";
	const oauth = auth.kind === "oauth";
	const body: JsonRecord = {
		model: target.modelId,
		input: openAiResponsesInput(request.messages),
		stream: true,
	};
	if (request.system !== undefined) {
		body.instructions = request.system;
	}
	if (!oauth && maxOutputTokens !== undefined) {
		body.max_output_tokens = maxOutputTokens;
	}
	if (optionValues?.store !== undefined) {
		body.store = optionValues.store;
	}
	const effort = optionValues?.reasoningEffort;
	const summary = optionValues?.reasoningSummary;
	if (effort !== undefined || summary !== undefined) {
		body.reasoning = {
			...(effort === undefined ? {} : { effort }),
			...(summary === undefined ? {} : { summary }),
		};
	}
	const tools = toolSchemas(request.tools, "openai-responses");
	if (tools) {
		body.tools = tools;
	}
	if (oauth) {
		return {
			protocol: "openai-responses",
			url: "https://chatgpt.com/backend-api/codex/responses",
			init: {
				method: "POST",
				headers: {
					...commonHeaders,
					authorization: `Bearer ${auth.accessToken}`,
					"chatgpt-account-id": auth.accountId,
					"openai-beta": "responses=experimental",
					originator: "wincode",
				},
				body: JSON.stringify(body),
			},
		};
	}
	if (apiKey === undefined) {
		throw new Error(
			"OpenAI model target requires API-key or OAuth authorization."
		);
	}
	return {
		protocol: "openai-responses",
		url: isGo
			? "https://opencode.ai/zen/go/v1/responses"
			: "https://api.openai.com/v1/responses",
		init: {
			method: "POST",
			headers: { ...commonHeaders, authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
		},
	};
};

const anthropicRequest = (context: ProviderRequestContext): ProviderRequest => {
	const {
		apiKey,
		commonHeaders,
		maxOutputTokens,
		model,
		optionValues,
		request,
	} = context;
	const { target } = request;
	if (apiKey === undefined) {
		throw new Error("Anthropic model target requires API-key authorization.");
	}
	const thinking = record(optionValues?.thinking);
	const body: JsonRecord = {
		model: target.modelId,
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
	const effort = optionValues?.effort;
	if (effort !== undefined) {
		body.output_config = { effort };
	}
	if (thinking && thinking.type !== "disabled") {
		body.thinking = {
			type: thinking.type,
			...(thinking.type === "enabled" &&
			typeof thinking.budgetTokens === "number"
				? { budget_tokens: thinking.budgetTokens }
				: {}),
		};
	}
	const tools = toolSchemas(request.tools, "anthropic");
	if (tools) {
		body.tools = tools;
	}
	const isGo = model.provider === "opencode-go";
	return {
		protocol: "anthropic",
		url: isGo
			? "https://opencode.ai/zen/go/v1/messages"
			: "https://api.anthropic.com/v1/messages",
		init: {
			method: "POST",
			headers: {
				...commonHeaders,
				"anthropic-version": "2023-06-01",
				"x-api-key": apiKey,
			},
			body: JSON.stringify(body),
		},
	};
};

const googleRequest = (context: ProviderRequestContext): ProviderRequest => {
	const { apiKey, commonHeaders, maxOutputTokens, optionValues, request } =
		context;
	const { target } = request;
	if (apiKey === undefined) {
		throw new Error("Google model target requires API-key authorization.");
	}
	const generationConfig: JsonRecord = {};
	if (maxOutputTokens !== undefined) {
		generationConfig.maxOutputTokens = maxOutputTokens;
	}
	const thinkingConfig = record(optionValues?.thinkingConfig);
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
	const tools = toolSchemas(request.tools, "google");
	if (tools) {
		body.tools = tools;
	}
	return {
		protocol: "google",
		url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(target.modelId)}:streamGenerateContent?alt=sse`,
		init: {
			method: "POST",
			headers: { ...commonHeaders, "x-goog-api-key": apiKey },
			body: JSON.stringify(body),
		},
	};
};

const openAiChatRequest = (
	context: ProviderRequestContext
): ProviderRequest => {
	const { apiKey, commonHeaders, maxOutputTokens, request } = context;
	const { target } = request;
	if (apiKey === undefined) {
		throw new Error("OpenCode Go model target requires API-key authorization.");
	}
	const body: JsonRecord = {
		model: target.modelId,
		messages: chatCompletionsMessages(request.messages, request.system),
		stream: true,
		stream_options: { include_usage: true },
	};
	if (maxOutputTokens !== undefined) {
		body.max_tokens = maxOutputTokens;
	}
	const tools = toolSchemas(request.tools, "openai-chat");
	if (tools) {
		body.tools = tools;
	}
	return {
		protocol: "openai-chat",
		url: "https://opencode.ai/zen/go/v1/chat/completions",
		init: {
			method: "POST",
			headers: { ...commonHeaders, authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
		},
	};
};

const unsupportedProviderRequest = (request: ModelStepRequest): never => {
	const { target } = request;
	throw new Error(
		`Unsupported model route: ${target.providerId}/${target.modelId}`
	);
};

const openCodeGoRequest = (
	context: ProviderRequestContext,
	model: OpenCodeGoModel
): ProviderRequest => {
	switch (model.protocol) {
		case "openai":
			return openAiResponsesRequest(context);
		case "anthropic":
			return anthropicRequest(context);
		case "openai-compatible":
			return openAiChatRequest(context);
		default:
			return unsupportedProviderRequest(context.request);
	}
};

const providerRequestForModel = (
	context: ProviderRequestContext
): ProviderRequest => {
	switch (context.model.provider) {
		case "openai":
			return openAiResponsesRequest(context);
		case "anthropic":
			return anthropicRequest(context);
		case "google":
			return googleRequest(context);
		case "opencode-go":
			return openCodeGoRequest(context, context.model);
		default:
			return unsupportedProviderRequest(context.request);
	}
};

export const buildProviderRequest = (
	request: ModelStepRequest,
	model: SupportedChatModel
): ProviderRequest =>
	providerRequestForModel(providerRequestContext(request, model));
