import { useChat as useAiChat } from "@ai-sdk/react";
import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
	ModeType,
	SkillContext,
} from "@wincode/ai";
import {
	defaultChatModelSelection,
	defaultMode,
	getChatModelRoute,
} from "@wincode/ai";
import {
	createUserMessage,
	handleCodingAgentToolCall,
} from "@wincode/ai/client";
import {
	type ChatAddToolOutputFunction,
	type ChatOnToolCallCallback,
	type FileUIPart,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMemo, useRef, useState } from "react";
import { useConnections } from "@/modules/connections";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import {
	type McpAddToolOutput,
	type McpCatalogSnapshot,
	type McpContextValue,
	useMcp,
} from "@/modules/mcp";
import { getConversationStore } from "../storage/get-conversation-store";
import { createSkillSnapshot } from "../utils";
import { createRoutingChatTransport } from "./routing-chat-transport";

type SubmitChatParams = {
	mode: ModeType;
	model: ChatModelSelection;
	variant?: ModelVariant;
	userText: string;
	files?: FileUIPart[];
	skill?: SkillContext;
};

type MutableRefObject<T> = { current: T };

export type ChatToolCallHandlerDeps = {
	addToolOutputRef: MutableRefObject<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>;
	handleCodingAgentToolCall?: typeof handleCodingAgentToolCall;
	mcp: Pick<McpContextValue, "handleDynamicToolCall">;
	mcpSnapshotRef: MutableRefObject<McpCatalogSnapshot | null>;
	modeRef: MutableRefObject<ModeType>;
};

/**
 * Dispatches AI SDK tool calls to the MCP handler for dynamic tools and to the
 * coding-agent handler otherwise. The AI SDK awaits `onToolCall`, but
 * `addToolOutput` queues on the same chat executor, so neither promise is
 * returned or awaited here or tool execution deadlocks at input-available.
 */
export const createChatToolCallHandler =
	({
		addToolOutputRef,
		handleCodingAgentToolCall: runStaticToolCall = handleCodingAgentToolCall,
		mcp,
		mcpSnapshotRef,
		modeRef,
	}: ChatToolCallHandlerDeps): ChatOnToolCallCallback<CodingAgentUIMessage> =>
	(options) => {
		const addToolOutput = addToolOutputRef.current;

		if (!addToolOutput) {
			return;
		}

		if (options.toolCall.dynamic) {
			// The AI SDK types addToolOutput for static coding tools, but dynamic
			// MCP tools carry arbitrary names; runtime matching is by toolCallId,
			// so bridge the type here.
			const mcpAddToolOutput = addToolOutput as unknown as McpAddToolOutput;
			Promise.resolve(
				mcp.handleDynamicToolCall(
					mcpSnapshotRef.current,
					options.toolCall,
					mcpAddToolOutput
				)
			).catch(() => undefined);
			return;
		}

		Promise.resolve(
			runStaticToolCall(addToolOutput, modeRef.current)(options)
		).catch(() => undefined);
	};

export const createChatMessageParts = (
	userText: string,
	fileMentions: CodingAgentUIMessage["parts"],
	files: FileUIPart[]
) => [{ text: userText, type: "text" as const }, ...fileMentions, ...files];

export const getContinuationChatParams = (
	mode: ModeType,
	model: ChatModelSelection,
	variant?: ModelVariant
): { mode: ModeType; model: ChatModelSelection; variant?: ModelVariant } => ({
	mode,
	model,
	...(variant === undefined ? {} : { variant }),
});

export const notifyHostedCompletion = (
	model: ChatModelSelection,
	onHostedCompletion?: () => void
): void => {
	if (getChatModelRoute(model) === "hosted") {
		onHostedCompletion?.();
	}
};

export const findCurrentTurnAssistantIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const userIndex = messages.findLastIndex(({ role }) => role === "user");
	const assistantIndex = messages.findLastIndex(
		({ role }) => role === "assistant"
	);

	return assistantIndex > userIndex ? assistantIndex : -1;
};

export const findCurrentTurnInterruptTargetIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const assistantIndex = findCurrentTurnAssistantIndex(messages);
	if (assistantIndex !== -1) {
		return assistantIndex;
	}

	return messages.findLastIndex(({ role }) => role === "user");
};

export const getOriginatingUserMessageId = (
	messages: CodingAgentUIMessage[]
): string | undefined => messages.findLast(({ role }) => role === "user")?.id;

export const finalizeAssistantMessageMetadata = (
	message: CodingAgentUIMessage,
	context: {
		mode: ModeType;
		model: ChatModelSelection;
		variant?: ModelVariant;
		interrupted: boolean;
		responseTimeMs?: number;
	}
): CodingAgentUIMessage => ({
	...message,
	metadata: (() => {
		const metadata = message.metadata ?? {};
		const nextMetadata: CodingAgentUIMessage["metadata"] = {
			...metadata,
			interrupted: context.interrupted,
			mode: message.metadata?.mode ?? context.mode,
			model: message.metadata?.model ?? context.model,
		};

		if (message.metadata?.variant !== undefined) {
			nextMetadata.variant = message.metadata.variant;
		} else if (context.variant !== undefined) {
			nextMetadata.variant = context.variant;
		}

		if (context.responseTimeMs !== undefined) {
			nextMetadata.responseTimeMs = context.responseTimeMs;
		}

		return nextMetadata;
	})(),
});

export function useChat(
	sessionId: string,
	initialMessages: CodingAgentUIMessage[],
	onHostedCompletion?: () => void
) {
	const connections = useConnections();
	const mcp = useMcp();
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const interruptedMessageIdsRef = useRef(new Set<string>());
	const requestStartedAtRef = useRef<number | null>(null);
	const setMessagesRef = useRef<
		((messages: CodingAgentUIMessage[]) => void) | undefined
	>(undefined);
	const modeRef = useRef<ModeType>(defaultMode.value);
	const modelRef = useRef<ChatModelSelection>(defaultChatModelSelection);
	const variantRef = useRef<ModelVariant | undefined>(undefined);
	const mcpSnapshotRef = useRef<McpCatalogSnapshot | null>(null);
	const [isPreparingMessage, setIsPreparingMessage] = useState(false);

	const transport = useMemo(() => {
		// The transport snapshots the MCP catalog once per send; mirror the same
		// immutable snapshot into a ref so dynamic tool dispatch resolves against
		// the exact catalog the request was built from.
		const mcpWithSnapshotRef: McpContextValue = {
			...mcp,
			createSnapshot: async (mode: ModeType) => {
				const snapshot = await mcp.createSnapshot(mode);
				mcpSnapshotRef.current = snapshot;
				return snapshot;
			},
		};

		return createRoutingChatTransport(
			sessionId,
			modeRef,
			modelRef,
			variantRef,
			connections,
			mcpWithSnapshotRef
		);
	}, [connections, mcp, sessionId]);

	const finalizeAssistantMessages = (messages: CodingAgentUIMessage[]) => {
		const startedAt = requestStartedAtRef.current;

		const responseTimeMs =
			startedAt === null ? undefined : Math.max(0, Date.now() - startedAt);
		const assistantIndex = messages.findLastIndex(
			(message) => message.role === "assistant"
		);

		if (assistantIndex === -1) {
			return messages;
		}

		const assistantMessage = messages[assistantIndex];
		if (!assistantMessage) {
			return messages;
		}

		const nextMessages = [...messages];
		nextMessages[assistantIndex] = {
			...finalizeAssistantMessageMetadata(assistantMessage, {
				interrupted: interruptedMessageIdsRef.current.has(assistantMessage.id),
				mode: modeRef.current,
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};

		return nextMessages;
	};

	const persistMessages = (messages: CodingAgentUIMessage[]) => {
		getConversationStore()
			.persistMessages({
				messages,
				mode: modeRef.current,
				model: modelRef.current,
				sessionId,
			})
			.catch(() => undefined);
	};

	const finalizeAndPersistMessages = (messages: CodingAgentUIMessage[]) => {
		const finalizedMessages = finalizeAssistantMessages(messages);
		setMessagesRef.current?.(finalizedMessages);
		persistMessages(finalizedMessages);
	};

	const chat = useAiChat<CodingAgentUIMessage>({
		id: sessionId,
		messages: initialMessages,
		onFinish: ({ messages }) => {
			finalizeAndPersistMessages(messages);
			notifyHostedCompletion(modelRef.current, onHostedCompletion);
		},
		onToolCall: createChatToolCallHandler({
			addToolOutputRef,
			mcp,
			mcpSnapshotRef,
			modeRef,
		}),
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport,
	});
	addToolOutputRef.current = chat.addToolOutput;
	setMessagesRef.current = chat.setMessages;

	const interruptLatestAssistantMessage = () => {
		const startedAt = requestStartedAtRef.current;
		const responseTimeMs =
			startedAt === null ? undefined : Math.max(0, Date.now() - startedAt);
		const targetIndex = findCurrentTurnInterruptTargetIndex(chat.messages);

		if (targetIndex === -1) {
			chat.stop();
			return;
		}

		const targetMessage = chat.messages[targetIndex];
		if (!targetMessage) {
			chat.stop();
			return;
		}

		if (targetMessage.role === "assistant") {
			interruptedMessageIdsRef.current.add(targetMessage.id);
		}
		const nextMessages = [...chat.messages];
		nextMessages[targetIndex] = {
			...finalizeAssistantMessageMetadata(targetMessage, {
				interrupted: true,
				mode: modeRef.current,
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};

		setMessagesRef.current?.(nextMessages);
		persistMessages(nextMessages);
		chat.stop();
	};

	const submit = async ({
		mode,
		model,
		variant,
		userText,
		files = [],
		skill,
	}: SubmitChatParams) => {
		modeRef.current = mode;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();
		const metadata = {
			mode,
			model,
			variant,
			...(skill ? { skill: createSkillSnapshot(skill) } : {}),
		};
		const optimisticMessage = createUserMessage(userText, metadata, [], files);
		chat.setMessages((messages) => [...messages, optimisticMessage]);
		setIsPreparingMessage(true);

		try {
			const fileMentions = await resolveFileMentionParts(userText);
			return await chat.sendMessage({
				messageId: optimisticMessage.id,
				metadata,
				parts: createChatMessageParts(userText, fileMentions, files),
			});
		} catch (error) {
			chat.setMessages((messages) =>
				messages.filter(({ id }) => id !== optimisticMessage.id)
			);
			throw error;
		} finally {
			setIsPreparingMessage(false);
		}
	};
	const continueLastMessage = (
		mode: ModeType,
		model: ChatModelSelection,
		variant?: ModelVariant
	) => {
		modeRef.current = mode;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();
		return chat.sendMessage();
	};

	return {
		abort: chat.stop,
		continueLastMessage,
		error: chat.error,
		interrupt: interruptLatestAssistantMessage,
		messages: chat.messages,
		status: chat.status,
		isPreparingMessage,
		submit,
	};
}
