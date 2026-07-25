import { useKeyboard } from "@opentui/react";
import {
	type CodingAgentUIMessage,
	normalizeChatModelSelection,
	normalizeModelVariant,
} from "@wincode/ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { derivePromptHistory } from "../../hooks/input-controller/history";
import { useChat } from "../../hooks/use-chat";
import { getLatestChatConfig, shouldAutoStartAssistantTurn } from "../../utils";
import { ChatShell } from "../components/chat-shell";
import type { ChatPromptSubmission } from "../components/chat-text-area";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

type ChatScreenProps = {
	autoStart: boolean;
	initialMessages: CodingAgentUIMessage[];
	initialPrompt: string;
	sessionId: string;
	sessionTitle: string;
	onHostedCompletion?: () => void;
};

export function ChatView({
	autoStart,
	initialMessages,
	initialPrompt,
	sessionId,
	sessionTitle,
	onHostedCompletion,
}: ChatScreenProps) {
	const { mode, model, setMode, setModel, setVariant, variant } =
		usePromptConfig();
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
		isPreparingMessage,
		messages,
		status,
		submit,
	} = useChat(sessionId, initialMessages, onHostedCompletion);
	const isBusy =
		isPreparingMessage || status === "submitted" || status === "streaming";
	const promptHistory = useMemo(
		() => derivePromptHistory(initialMessages),
		[initialMessages]
	);

	useEffect(() => {
		const config = getLatestChatConfig(initialMessages);
		if (!config) {
			return;
		}

		setMode(config.mode);
		setModel(config.model);
		setVariant(config.variant);
	}, [initialMessages, setMode, setModel, setVariant]);

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

	const submitMessage = ({ files, text }: ChatPromptSubmission) => {
		if (isBusy) {
			return false;
		}

		const userText = text.trim();
		if (!userText && files.length === 0) {
			return false;
		}

		submit({ files, mode, model, variant, userText }).catch(() => undefined);
		return true;
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
		submit({ mode, model, variant, userText: submittedPrompt }).catch(
			() => undefined
		);
	}, [initialPrompt, mode, model, submit, variant]);

	useEffect(() => {
		const lastInitialMessage = initialMessages.at(-1);

		if (
			!(
				lastInitialMessage &&
				shouldAutoStartAssistantTurn(
					autoStart,
					initialPrompt,
					lastInitialMessage
				)
			)
		) {
			return;
		}

		if (submittedInitialMessageRef.current === lastInitialMessage.id) {
			return;
		}

		submittedInitialMessageRef.current = lastInitialMessage.id;
		const resolvedModel =
			normalizeChatModelSelection(
				lastInitialMessage.metadata?.model ?? model
			) ?? model;
		const persistedVariant = normalizeModelVariant(
			resolvedModel,
			lastInitialMessage.metadata?.variant
		);

		continueLastMessage(
			lastInitialMessage.metadata?.mode ?? mode,
			resolvedModel,
			persistedVariant
		).catch(() => undefined);
	}, [
		autoStart,
		continueLastMessage,
		initialMessages,
		initialPrompt,
		mode,
		model,
	]);

	return (
		<ChatShell
			error={error}
			isBusy={isBusy}
			isInterruptArmed={isInterruptArmed}
			messages={messages}
			onSubmit={submitMessage}
			promptHistory={promptHistory}
		/>
	);
}
