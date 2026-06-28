import { useKeyboard } from "@opentui/react";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useEffect, useRef, useState } from "react";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { useChat } from "../../hooks/use-chat";
import { ChatShell } from "../components/chat-shell";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

type ChatScreenProps = {
	initialMessages: CodingAgentUIMessage[];
	initialPrompt: string;
	sessionId: string;
	sessionTitle: string;
};

export function ChatView({
	initialMessages,
	initialPrompt,
	sessionId,
	sessionTitle,
}: ChatScreenProps) {
	const { mode, model } = usePromptConfig();
	const { isTopLayer } = useKeyboardLayer();
	const dialog = useDialog();
	const { show } = useToast();
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
		if (!isTopLayer("base")) {
			return;
		}

		if (key.name === "escape" && isBusy) {
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
			return;
		}

		if (key.ctrl && key.name === "r") {
			key.preventDefault();
			dialog.open({
				children: (
					<RenameSessionDialog
						onSuccess={(_newTitle) => {
							show({
								message: "Session renamed",
								variant: "success",
							});
						}}
						session={{ id: sessionId, title: sessionTitle }}
					/>
				),
				title: "Rename Session",
			});
		}
	});

	useEffect(
		() => () => {
			abort();
		},
		[abort]
	);

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
