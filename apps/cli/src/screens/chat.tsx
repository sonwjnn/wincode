import { useChat } from "@ai-sdk/react";
import { useTerminalDimensions } from "@opentui/react";
import { useRouterState } from "@tanstack/react-router";
import { DefaultChatTransport } from "ai";
import { useEffect, useReducer, useRef } from "react";
import { ChatShell } from "../components/chat/chat-shell";
import { getChatTextAreaWidth } from "../components/chat/chat-text-area";
import { honoClient } from "../lib/client";

const chatApi = honoClient.api.chat.$url().toString();

export function ChatScreen() {
	const { width } = useTerminalDimensions();
	const prompt = useRouterState({
		select: (state) => state.location.state.input ?? "",
	});
	const submittedPromptRef = useRef<string | null>(null);
	const [inputKey, resetInput] = useReducer((key: number) => key + 1, 0);
	const { error, messages, sendMessage, status } = useChat({
		transport: new DefaultChatTransport({
			api: chatApi,
			body: { sendReasoning: true },
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
		const submittedPrompt = prompt.trim();
		if (!(submittedPrompt && submittedPromptRef.current !== submittedPrompt)) {
			return;
		}

		submittedPromptRef.current = submittedPrompt;
		sendMessage({ text: submittedPrompt }).catch(() => undefined);
	}, [prompt, sendMessage]);

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
