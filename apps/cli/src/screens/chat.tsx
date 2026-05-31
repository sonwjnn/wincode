import { useKeyboard } from "@opentui/react";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useEffect, useRef, useState } from "react";
import { ChatShell } from "../components/chat/chat-shell";
import { useChat } from "../hooks/use-chat";
import { usePromptConfig } from "../providers/prompt-config";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

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
	const { mode, model } = usePromptConfig();
	const submittedPromptRef = useRef<string | null>(null);
	const submittedInitialMessageRef = useRef<string | null>(null);
	const interruptResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	const interruptArmedRef = useRef(false);
	const [isInterruptArmed, setIsInterruptArmed] = useState(false);
	const {
		abort,
		continueLastMessage,
		error,
		interrupt,
		messages,
		status,
		submit,
	} = useChat(sessionId, initialMessages);
	const isBusy = status === "submitted" || status === "streaming";

	useEffect(
		() => () => {
			abort();
		},
		[abort]
	);

	useKeyboard((key) => {
		if (key.name !== "escape" || !isBusy) {
			return;
		}

		key.preventDefault();

		if (interruptArmedRef.current) {
			if (interruptResetTimeoutRef.current) {
				clearTimeout(interruptResetTimeoutRef.current);
				interruptResetTimeoutRef.current = null;
			}

			interruptArmedRef.current = false;
			setIsInterruptArmed(false);
			interrupt();
			return;
		}

		interruptArmedRef.current = true;
		setIsInterruptArmed(true);

		if (interruptResetTimeoutRef.current) {
			clearTimeout(interruptResetTimeoutRef.current);
		}

		interruptResetTimeoutRef.current = setTimeout(() => {
			interruptArmedRef.current = false;
			setIsInterruptArmed(false);
			interruptResetTimeoutRef.current = null;
		}, INTERRUPT_CONFIRMATION_TIMEOUT_MS);
	});

	useEffect(() => {
		if (isBusy) {
			return;
		}

		if (interruptResetTimeoutRef.current) {
			clearTimeout(interruptResetTimeoutRef.current);
			interruptResetTimeoutRef.current = null;
		}

		interruptArmedRef.current = false;
		setIsInterruptArmed(false);
	}, [isBusy]);

	useEffect(
		() => () => {
			if (interruptResetTimeoutRef.current) {
				clearTimeout(interruptResetTimeoutRef.current);
			}
		},
		[]
	);

	const submitMessage = (value: string) => {
		if (isBusy) {
			return;
		}

		const text = value.trim();
		if (!text) {
			return;
		}

		submit({ mode, model, userText: text }).catch(() => undefined);
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
		submit({ mode, model, userText: submittedPrompt }).catch(() => undefined);
	}, [initialPrompt, mode, model, submit]);

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
		continueLastMessage(
			lastInitialMessage.metadata?.mode ?? mode,
			lastInitialMessage.metadata?.model ?? model
		).catch(() => undefined);
	}, [continueLastMessage, initialMessages, initialPrompt, mode, model]);

	return (
		<ChatShell
			error={error}
			isBusy={isBusy}
			isInterruptArmed={isInterruptArmed}
			messages={messages}
			onSubmit={submitMessage}
		/>
	);
}
