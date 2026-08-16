import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type ModelVariant,
	normalizeChatModelSelection,
	normalizeModelVariant,
} from "@wincode/ai";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { derivePromptHistory } from "../../hooks/input-controller/history";
import { hasPendingToolExecutionStep, useChat } from "../../hooks/use-chat";
import { resolveConversationSelection } from "../../selection";
import type { ChatPromptSubmission } from "../../utils";
import { shouldAutoStartAssistantTurn } from "../../utils";
import { ChatShell } from "../components/chat-shell";
import { SessionSidebar } from "../components/session-sidebar";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;
const SIDEBAR_WIDTH = "30%";
const SIDEBAR_MIN_TERMINAL_WIDTH = 100;

type ChatScreenProps = {
	autoStart: boolean;
	initialMessages: CodingAgentUIMessage[];
	initialModel?: ChatModelSelection;
	initialPrompt: string;
	initialVariant?: ModelVariant;
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
	initialModel,
	initialPrompt,
	initialVariant,
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
	// Messages restored from storage carry no in-flight tool executions (the
	// owning process died with them). Their ids keep a persisted
	// interrupted-turn part from holding isBusy true forever after reload.
	const loadedMessageIds = useMemo(
		() => new Set(initialMessages.map((message) => message.id)),
		[initialMessages]
	);
	const submittedPromptRef = useRef<string | null>(null);
	const submittedInitialMessageRef = useRef<string | null>(null);
	const interruptResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	const interruptArmedRef = useRef(false);
	const [isInterruptArmed, setIsInterruptArmed] = useState(false);
	const [restoredMessages, setRestoredMessages] = useState<
		CodingAgentUIMessage[] | null
	>(null);
	const {
		abort,
		catalogDiagnostic,
		continueLastMessage,
		error,
		interrupt,
		isPreparingMessage,
		messages,
		status,
		submit,
	} = useChat(sessionId, initialMessages, onHostedCompletion);
	const isBusy =
		isPreparingMessage ||
		status === "submitted" ||
		status === "streaming" ||
		// Between agentic steps the SDK drops to status "ready" while tool
		// executions are still in flight; without this the turn looks stopped
		// (spinner gone) and Esc interrupt cannot be armed. See use-chat.ts.
		hasPendingToolExecutionStep(messages, loadedMessageIds);
	const promptHistory = useMemo(
		() => derivePromptHistory(initialMessages),
		[initialMessages]
	);
	const restoredConfig = useMemo(() => {
		if (registry === null) {
			return null;
		}
		return resolveConversationSelection({
			messages: initialMessages,
			resolveAgent: (agentId) => resolveActiveAgentId(registry, agentId),
			sessionModel: initialModel,
			sessionVariant: initialVariant,
		});
	}, [initialMessages, initialModel, initialVariant, registry]);
	const isPromptConfigRestored = restoredMessages === initialMessages;

	useEffect(() => {
		if (registry === null) {
			return;
		}
		if (!restoredConfig) {
			setRestoredMessages(initialMessages);
			return;
		}

		if (restoredConfig.agent) {
			setAgent(restoredConfig.agent);
		}
		setModel(restoredConfig.model);
		setVariant(restoredConfig.variant);
		setRestoredMessages(initialMessages);
		if (
			restoredConfig.persistedAgent !== undefined &&
			restoredConfig.agent !== restoredConfig.persistedAgent
		) {
			show({
				message: `Saved Agent "${restoredConfig.persistedAgent}" is unavailable. Using Build.`,
				variant: "error",
			});
		}
	}, [
		initialMessages,
		registry,
		restoredConfig,
		setAgent,
		setModel,
		setVariant,
		show,
	]);

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

	const submitMessage = async (submission: ChatPromptSubmission) => {
		if (isBusy || registry === null || !isPromptConfigRestored) {
			return false;
		}

		const { files, text, skill } = submission;
		const userText = text.trim();
		if (!hasChatPromptContent(submission)) {
			return false;
		}

		const effective = resolveEffectiveAgentSelection(
			registry,
			agent,
			model,
			variant
		);
		const outcome = await submit({
			agent: effective.agent,
			conversationModel: model,
			conversationVariant: variant,
			files,
			model: effective.model,
			resolvedAgent: effective.resolvedAgent,
			variant: effective.variant,
			userText,
			skill,
		}).catch(() => ({ rejected: true, reason: "Could not submit the prompt" }));
		if (outcome.rejected) {
			// The input and attachments stay in the textarea so a rejected
			// explicit Skill submission never silently changes intent.
			show({ message: outcome.reason, variant: "error" });
			return false;
		}
		return true;
	};

	useEffect(() => {
		if (catalogDiagnostic !== null) {
			show({ message: catalogDiagnostic, variant: "error" });
		}
	}, [catalogDiagnostic, show]);

	useEffect(() => {
		const submittedPrompt = initialPrompt.trim();
		if (!submittedPrompt || registry === null || !isPromptConfigRestored) {
			return;
		}

		if (submittedPromptRef.current === submittedPrompt) {
			return;
		}

		submittedPromptRef.current = submittedPrompt;
		const conversationAgent = restoredConfig?.agent ?? agent;
		const conversationModel = restoredConfig?.model ?? model;
		const conversationVariant = restoredConfig?.variant ?? variant;
		const effective = resolveEffectiveAgentSelection(
			registry,
			conversationAgent,
			conversationModel,
			conversationVariant
		);
		submit({
			agent: effective.agent,
			conversationModel,
			conversationVariant,
			model: effective.model,
			resolvedAgent: effective.resolvedAgent,
			variant: effective.variant,
			userText: submittedPrompt,
		}).catch(() => undefined);
	}, [
		agent,
		initialPrompt,
		isPromptConfigRestored,
		model,
		registry,
		restoredConfig,
		submit,
		variant,
	]);

	useEffect(() => {
		const lastInitialMessage = initialMessages.at(-1);

		if (
			registry === null ||
			!isPromptConfigRestored ||
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
			restoredConfig?.variant ?? lastInitialMessage.metadata?.variant
		);

		const conversationModel = restoredConfig?.model ?? model;
		const conversationVariant = restoredConfig?.variant ?? variant;
		const persistedAgentId =
			lastInitialMessage.metadata?.agent ?? restoredConfig?.agent ?? agent;
		const persistedAgentIsAvailable = registry.selectableAgents.some(
			({ id, isAvailable }) => id === persistedAgentId && isAvailable
		);
		const effective = resolveEffectiveAgentSelection(
			registry,
			persistedAgentId,
			persistedAgentIsAvailable ? resolvedModel : conversationModel,
			persistedAgentIsAvailable ? persistedVariant : conversationVariant
		);
		continueLastMessage(
			effective.agent,
			effective.model,
			effective.variant,
			effective.resolvedAgent,
			conversationModel,
			conversationVariant
		)
			.then((outcome) => {
				if (outcome?.rejected) {
					show({ message: outcome.reason, variant: "error" });
				}
			})
			.catch(() => undefined);
	}, [
		agent,
		autoStart,
		continueLastMessage,
		initialMessages,
		initialPrompt,
		isPromptConfigRestored,
		model,
		registry,
		restoredConfig,
		show,
		variant,
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
