import { useChat as useAiChat } from "@ai-sdk/react";
import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
	ModeType,
} from "@wincode/ai";
import { defaultChatModelSelection, defaultMode } from "@wincode/ai";
import { handleCodingAgentToolCall } from "@wincode/ai/client";
import {
	type ChatAddToolOutputFunction,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMemo, useRef } from "react";
import { useConnections } from "@/modules/connections";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { getConversationStore } from "../storage/get-conversation-store";
import { createRoutingChatTransport } from "./routing-chat-transport";

type SubmitChatParams = {
	mode: ModeType;
	model: ChatModelSelection;
	variant?: ModelVariant;
	userText: string;
};

export const getContinuationChatParams = (
	mode: ModeType,
	model: ChatModelSelection,
	variant?: ModelVariant
): { mode: ModeType; model: ChatModelSelection; variant?: ModelVariant } => ({
	mode,
	model,
	...(variant === undefined ? {} : { variant }),
});

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
	initialMessages: CodingAgentUIMessage[]
) {
	const connections = useConnections();
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

	const transport = useMemo(
		() =>
			createRoutingChatTransport(
				sessionId,
				modeRef,
				modelRef,
				variantRef,
				connections
			),
		[connections, sessionId]
	);

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
		},
		onToolCall: (options) => {
			const addToolOutputForCall = addToolOutputRef.current;

			if (!addToolOutputForCall) {
				return;
			}

			// AI SDK awaits onToolCall, but addToolOutput queues on the same chat executor.
			// Do not await this call or tool execution can deadlock at input-available.
			Promise.resolve(
				handleCodingAgentToolCall(
					addToolOutputForCall,
					modeRef.current
				)(options)
			).catch(() => undefined);
		},
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport,
	});
	addToolOutputRef.current = chat.addToolOutput;
	setMessagesRef.current = chat.setMessages;

	const interruptLatestAssistantMessage = () => {
		const startedAt = requestStartedAtRef.current;
		const responseTimeMs =
			startedAt === null ? undefined : Math.max(0, Date.now() - startedAt);
		const assistantIndex = chat.messages.findLastIndex(
			(message) => message.role === "assistant"
		);

		if (assistantIndex === -1) {
			chat.stop();
			return;
		}

		const assistantMessage = chat.messages[assistantIndex];
		if (!assistantMessage) {
			chat.stop();
			return;
		}

		interruptedMessageIdsRef.current.add(assistantMessage.id);
		const nextMessages = [...chat.messages];
		nextMessages[assistantIndex] = {
			...finalizeAssistantMessageMetadata(assistantMessage, {
				interrupted: true,
				mode: modeRef.current,
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};

		finalizeAndPersistMessages(nextMessages);
		chat.stop();
	};

	const submit = async ({
		mode,
		model,
		variant,
		userText,
	}: SubmitChatParams) => {
		modeRef.current = mode;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();
		const fileMentions = await resolveFileMentionParts(userText);

		return chat.sendMessage({
			metadata: { mode, model, variant: variantRef.current },
			parts: [{ text: userText, type: "text" }, ...fileMentions],
		});
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
		submit,
	};
}
