import { useChat as useAiChat } from "@ai-sdk/react";
import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModeType,
} from "@wincode/ai";
import { defaultChatModelSelection, defaultMode } from "@wincode/ai";
import { handleCodingAgentToolCall } from "@wincode/ai/client";
import {
	type ChatAddToolOutputFunction,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMemo, useRef } from "react";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { getConversationStore } from "../storage/get-conversation-store";
import { createRoutingChatTransport } from "./routing-chat-transport";

type SubmitChatParams = {
	mode: ModeType;
	model: ChatModelSelection;
	userText: string;
};

export function useChat(
	sessionId: string,
	initialMessages: CodingAgentUIMessage[]
) {
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const interruptedMessageIdsRef = useRef(new Set<string>());
	const requestStartedAtRef = useRef<number | null>(null);
	const setMessagesRef = useRef<
		((messages: CodingAgentUIMessage[]) => void) | undefined
	>(undefined);
	const modeRef = useRef<ModeType>(defaultMode.value);
	const modelRef = useRef<ChatModelSelection>(defaultChatModelSelection);

	const transport = useMemo(
		() => createRoutingChatTransport(sessionId, modeRef, modelRef),
		[sessionId]
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

		const metadata = assistantMessage.metadata ?? {};
		const nextMessages = [...messages];
		nextMessages[assistantIndex] = {
			...assistantMessage,
			metadata: {
				...metadata,
				mode: metadata.mode ?? modeRef.current,
				model: metadata.model ?? modelRef.current,
				...(interruptedMessageIdsRef.current.has(assistantMessage.id)
					? { interrupted: true }
					: {}),
				...(responseTimeMs === undefined ? {} : { responseTimeMs }),
			},
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

	const chat = useAiChat<CodingAgentUIMessage>({
		id: sessionId,
		messages: initialMessages,
		onFinish: ({ messages }) => {
			const finalizedMessages = finalizeAssistantMessages(messages);
			setMessagesRef.current?.(finalizedMessages);
			getConversationStore()
				.persistMessages({
					messages: finalizedMessages,
					mode: modeRef.current,
					model: modelRef.current,
					sessionId,
				})
				.catch(() => undefined);
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

		const metadata = assistantMessage.metadata ?? {};
		interruptedMessageIdsRef.current.add(assistantMessage.id);
		const nextMessages = [...chat.messages];
		nextMessages[assistantIndex] = {
			...assistantMessage,
			metadata: {
				...metadata,
				interrupted: true,
				mode: metadata.mode ?? modeRef.current,
				model: metadata.model ?? modelRef.current,
				...(responseTimeMs === undefined ? {} : { responseTimeMs }),
			},
		};

		chat.setMessages(nextMessages);
		persistMessages(nextMessages);
		chat.stop();
	};

	const submit = async ({ mode, model, userText }: SubmitChatParams) => {
		modeRef.current = mode;
		modelRef.current = model;
		requestStartedAtRef.current = Date.now();
		const fileMentions = await resolveFileMentionParts(userText);

		return chat.sendMessage({
			metadata: { mode, model },
			parts: [{ text: userText, type: "text" }, ...fileMentions],
		});
	};
	const continueLastMessage = (mode: ModeType, model: ChatModelSelection) => {
		modeRef.current = mode;
		modelRef.current = model;
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
