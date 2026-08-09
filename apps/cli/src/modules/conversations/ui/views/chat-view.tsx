import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
	type CodingAgentUIMessage,
	normalizeChatModelSelection,
	normalizeModelVariant,
} from "@wincode/ai";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	resolveExecutableAgentRuntime,
	useAgentRegistry,
} from "@/modules/agents";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { derivePromptHistory } from "../../hooks/input-controller/history";
import { useChat } from "../../hooks/use-chat";
import type { ChatPromptSubmission } from "../../utils";
import { getLatestChatConfig, shouldAutoStartAssistantTurn } from "../../utils";
import { ChatShell } from "../components/chat-shell";
import { SessionSidebar } from "../components/session-sidebar";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;
const SIDEBAR_WIDTH = "30%";
const SIDEBAR_MIN_TERMINAL_WIDTH = 100;

type ChatScreenProps = {
	autoStart: boolean;
	initialMessages: CodingAgentUIMessage[];
	initialPrompt: string;
	sessionId: string;
	sessionTitle: string;
	onHostedCompletion?: () => void;
};

export const hasChatPromptContent = ({
	files,
	skill,
	text,
}: ChatPromptSubmission): boolean =>
	text.trim().length > 0 || files.length > 0 || skill !== undefined;

export function ChatView({
	autoStart,
	initialMessages,
	initialPrompt,
	sessionId,
	sessionTitle,
	onHostedCompletion,
}: ChatScreenProps) {
	const { agent, model, setAgent, setModel, setVariant, variant } =
		usePromptConfig();
	const { width: terminalWidth } = useTerminalDimensions();
	const showSidebar = terminalWidth >= SIDEBAR_MIN_TERMINAL_WIDTH;
	const registry = useAgentRegistry();
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

		setAgent(config.agent);
		setModel(config.model);
		setVariant(config.variant);
	}, [initialMessages, setAgent, setModel, setVariant]);

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

	const submitMessage = (submission: ChatPromptSubmission) => {
		if (isBusy) {
			return false;
		}

		const { files, text, skill } = submission;
		const userText = text.trim();
		if (!hasChatPromptContent(submission)) {
			return false;
		}

		submit({
			agent,
			files,
			model,
			resolvedAgent: resolveExecutableAgentRuntime(registry, agent),
			variant,
			userText,
			skill,
		}).catch(() => undefined);
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
		submit({
			agent,
			model,
			resolvedAgent: resolveExecutableAgentRuntime(registry, agent),
			variant,
			userText: submittedPrompt,
		}).catch(() => undefined);
	}, [agent, initialPrompt, model, registry, submit, variant]);

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
			lastInitialMessage.metadata?.agent ?? agent,
			resolvedModel,
			persistedVariant,
			resolveExecutableAgentRuntime(
				registry,
				lastInitialMessage.metadata?.agent ?? agent
			)
		).catch(() => undefined);
	}, [
		agent,
		autoStart,
		continueLastMessage,
		initialMessages,
		initialPrompt,
		model,
		registry,
	]);

	return (
		<box flexDirection="row" height="100%" width="100%">
			<box flexGrow={1} height="100%" paddingX={1}>
				<ChatShell
					error={error}
					isBusy={isBusy}
					isInterruptArmed={isInterruptArmed}
					messages={messages}
					onSubmit={submitMessage}
					promptHistory={promptHistory}
				/>
			</box>
			{showSidebar ? (
				<SessionSidebar
					messages={messages}
					sessionTitle={sessionTitle}
					width={SIDEBAR_WIDTH}
				/>
			) : null}
		</box>
	);
}
