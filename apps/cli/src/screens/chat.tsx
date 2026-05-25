import { useChat } from "@ai-sdk/react";
import { useTerminalDimensions } from "@opentui/react";
import {
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
	type UIMessage,
} from "ai";
import { useEffect, useReducer, useRef } from "react";
import { ChatShell } from "../components/chat/chat-shell";
import { getChatTextAreaWidth } from "../components/chat/chat-text-area";
import { honoClient } from "../lib/client";
import { runTool } from "../tools/run-tool";

type ChatScreenProps = {
	initialMessages: UIMessage[];
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
	const [inputKey, resetInput] = useReducer((key: number) => key + 1, 0);

	const { addToolOutput, error, messages, sendMessage, status } = useChat({
		id: sessionId,
		messages: initialMessages,
		async onToolCall({ toolCall }) {
			if (toolCall.dynamic) {
				return;
			}

			try {
				const output = await runTool(toolCall.toolName, toolCall.input);

				addToolOutput({
					output,
					tool: toolCall.toolName,
					toolCallId: toolCall.toolCallId,
				});
			} catch (toolError) {
				addToolOutput({
					errorText:
						toolError instanceof Error
							? toolError.message
							: "Tool execution failed.",
					state: "output-error",
					tool: toolCall.toolName,
					toolCallId: toolCall.toolCallId,
				});
			}
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
