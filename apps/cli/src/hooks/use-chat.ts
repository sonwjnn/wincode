import { useChat as useAiChat } from "@ai-sdk/react";
import type {
	CodingAgentUIMessage,
	ModeType,
	SupportedChatModelId,
} from "@wincode/ai";
import { defaultChatModel, defaultMode } from "@wincode/ai";
import { handleCodingAgentToolCall } from "@wincode/ai/client";
import {
	type ChatAddToolOutputFunction,
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMemo, useRef } from "react";
import { honoClient } from "../lib/client";
import { prepareSendChatRequestBody } from "./chat-request";

type SubmitChatParams = {
	mode: ModeType;
	model: SupportedChatModelId;
	userText: string;
};

export function useChat(
	sessionId: string,
	initialMessages: CodingAgentUIMessage[]
) {
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const modeRef = useRef<ModeType>(defaultMode.value);
	const modelRef = useRef<SupportedChatModelId>(defaultChatModel.value);

	const transport = useMemo(
		() =>
			new DefaultChatTransport<CodingAgentUIMessage>({
				api: honoClient.api.sessions[":id"].chat
					.$url({ param: { id: sessionId } })
					.toString(),
				prepareSendMessagesRequest: ({ messages }) => ({
					body: prepareSendChatRequestBody(sessionId, messages, {
						mode: modeRef.current,
						model: modelRef.current,
					}),
				}),
			}),
		[sessionId]
	);

	const chat = useAiChat<CodingAgentUIMessage>({
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

	const submit = ({ mode, model, userText }: SubmitChatParams) => {
		modeRef.current = mode;
		modelRef.current = model;
		return chat.sendMessage({
			metadata: { mode, model },
			text: userText,
		});
	};
	const continueLastMessage = (mode: ModeType, model: SupportedChatModelId) => {
		modeRef.current = mode;
		modelRef.current = model;
		return chat.sendMessage();
	};

	return {
		abort: chat.stop,
		continueLastMessage,
		error: chat.error,
		interrupt: chat.stop,
		messages: chat.messages,
		status: chat.status,
		submit,
	};
}
