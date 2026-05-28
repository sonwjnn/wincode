import { useChat } from "@ai-sdk/react";
import { useTerminalDimensions } from "@opentui/react";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { handleCodingAgentToolCall } from "@wincode/ai/client";
import {
	type ChatAddToolOutputFunction,
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useEffect, useReducer, useRef } from "react";
import { ChatShell } from "../components/chat/chat-shell";
import { getChatTextAreaWidth } from "../components/chat/chat-text-area";
import { honoClient } from "../lib/client";

type ChatScreenProps = {
	initialMessages: CodingAgentUIMessage[];
	initialPrompt: string;
	sessionId: string;
};

export function ChatScreen({
	initialMessages,
	initialPrompt,
	sessionId,
}: ChatScreenProps) {
	const { width } = useTerminalDimensions();
	const submittedPromptRef = useRef<string | null>(null);
	const submittedInitialMessageRef = useRef<string | null>(null);
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const [inputKey, resetInput] = useReducer((key: number) => key + 1, 0);

	const { addToolOutput, error, messages, sendMessage, status } =
		useChat<CodingAgentUIMessage>({
			id: sessionId,
			messages: initialMessages,
			onToolCall: (options) => {
				const addToolOutputForCall = addToolOutputRef.current;

				if (!addToolOutputForCall) {
					return;
				}

				// AI SDK awaits onToolCall, but addToolOutput queues on the same chat executor.
				// Do not await this call or tool execution can deadlock at input-available.
				Promise.resolve(
					handleCodingAgentToolCall(addToolOutputForCall)(options)
				).catch(() => undefined);
			},
			sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
			transport: new DefaultChatTransport({
				api: honoClient.api.sessions[":id"].chat
					.$url({ param: { id: sessionId } })
					.toString(),
				prepareSendMessagesRequest: ({ messages: requestMessages }) => ({
					body: {
						message: requestMessages.at(-1),
						sendReasoning: true,
					},
				}),
			}),
		});
	const isBusy = status === "submitted" || status === "streaming";
	const inputWidth = getChatTextAreaWidth(width, 88);
	addToolOutputRef.current = addToolOutput;

	const submitMessage = (value: string) => {
		if (isBusy) {
			return;
		}

		const text = value.trim();
		if (!text) {
			return;
		}

		resetInput();
		sendMessage({ text }).catch(() => undefined);
	};

	useEffect(() => {
		const submittedPrompt = initialPrompt.trim();
		if (!submittedPrompt) {
			return;
		}

		if (submittedPromptRef.current === submittedPrompt) {
			return;
		}

		submittedPromptRef.current = submittedPrompt;
		sendMessage({ text: submittedPrompt }).catch(() => undefined);
	}, [initialPrompt, sendMessage]);

	useEffect(() => {
		if (initialPrompt.trim()) {
			return;
		}

		const lastInitialMessage = initialMessages.at(-1);

		if (lastInitialMessage?.role !== "user") {
			return;
		}

		if (submittedInitialMessageRef.current === lastInitialMessage.id) {
			return;
		}

		submittedInitialMessageRef.current = lastInitialMessage.id;
		sendMessage().catch(() => undefined);
	}, [initialMessages, initialPrompt, sendMessage]);

	return (
		<ChatShell
			error={error}
			inputKey={inputKey}
			inputWidth={inputWidth}
			isBusy={isBusy}
			messages={messages}
			onSubmit={submitMessage}
		/>
	);
}
