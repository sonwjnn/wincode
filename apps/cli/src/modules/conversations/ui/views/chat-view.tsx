import { useKeyboard } from "@opentui/react";
import type { CodingAgentUIMessage } from "@wincode/ai";
import {
	type ChatModelSelection,
	type ModelVariant,
	normalizeChatModelSelection,
	normalizeModelVariant,
} from "@wincode/ai/models";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useSettingsHubDialog } from "@/modules/settings";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import {
	type ConversationCompaction,
	isSettingsCommand,
	parseCompactCommand,
} from "../../compaction";
import { hasPendingToolExecutionStep } from "../../hooks/auto-send-gate";
import { derivePromptHistory } from "../../hooks/input-controller/history";
import { useChat } from "../../hooks/use-chat";
import { resolveConversationSelection } from "../../selection";
import type { ChatPromptSubmission } from "../../utils";
import { shouldAutoStartAssistantTurn } from "../../utils";
import { ChatShell } from "../components/chat-shell";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

type ChatScreenProps = {
	autoStart: boolean;
	initialActiveMessages?: CodingAgentUIMessage[];
	initialCompactions?: ConversationCompaction[];
	initialMessages: CodingAgentUIMessage[];
	initialModel?: ChatModelSelection;
	initialVariant?: ModelVariant;
	sessionId: string;
	sessionTitle: string;
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
	initialActiveMessages = initialMessages,
	initialCompactions = [],
	initialModel,
	initialVariant,
	sessionId,
	sessionTitle,
}: ChatScreenProps) {
	const { agent, model, setAgent, setModel, setVariant, variant } =
		usePromptConfig();
	const settingsRuntime = useMemo(
		() => ({ model, sessionId }),
		[model, sessionId]
	);
	const registry = useAgentRegistry();
	const { isTopLayer } = useKeyboardLayer();
	const dialog = useDialog();
	const { show } = useToast();
	const openSettings = useSettingsHubDialog(settingsRuntime);
	const hasPendingApproval = useApprovalPanels().entries.some(
		(entry) => entry.resolution === undefined
	);
	// Messages restored from storage carry no in-flight tool executions (the
	// owning process died with them). Their ids keep a persisted
	// interrupted-turn part from holding isBusy true forever after reload.
	const loadedMessageIds = useMemo(
		() => new Set(initialMessages.map((message) => message.id)),
		[initialMessages]
	);
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
		cancelCompaction,
		catalogDiagnostic,
		compact,
		compactions,
		conversation,
		error,
		isCompacting,
		isPreparingMessage,
		messages,
		status,
	} = useChat(
		sessionId,
		initialMessages,
		initialActiveMessages,
		initialCompactions
	);
	const { cancel, interrupt, send } = conversation;
	const isTurnBusy =
		hasPendingApproval ||
		isPreparingMessage ||
		status === "submitted" ||
		status === "streaming" ||
		// Between agentic steps the SDK drops to status "ready" while tool
		// executions are still in flight; without this the turn looks stopped
		// (spinner gone) and Esc interrupt cannot be armed. See use-chat.ts.
		hasPendingToolExecutionStep(messages, loadedMessageIds);
	const isBusy = isTurnBusy || isCompacting;
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
			cancel();
		},
		[cancel]
	);

	const handleInterrupt = () => {
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

		clearTimeout(interruptResetTimeoutRef.current ?? 0);

		interruptResetTimeoutRef.current = setTimeout(() => {
			interruptArmedRef.current = false;
			setIsInterruptArmed(false);
			interruptResetTimeoutRef.current = null;
		}, INTERRUPT_CONFIRMATION_TIMEOUT_MS);
	};
	useKeyboard((key) => {
		if (!isTopLayer("base")) {
			return;
		}
		if (key.name === "escape") {
			if (isCompacting) {
				key.preventDefault();
				cancelCompaction();
				return;
			}
			if (!isBusy) {
				return;
			}
			key.preventDefault();
			handleInterrupt();
			return;
		}
		if (!(key.ctrl && key.name === "r")) {
			return;
		}
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
	});

	useEffect(
		() => () => {
			cancel();
		},
		[cancel]
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
			clearTimeout(interruptResetTimeoutRef.current ?? 0);
		},
		[]
	);

	const runManualCompaction = async (focus?: string): Promise<boolean> => {
		if (
			isTurnBusy ||
			isCompacting ||
			registry === null ||
			!isPromptConfigRestored
		) {
			show({
				message: "Compaction is unavailable while the conversation is active.",
				variant: "error",
			});
			return false;
		}
		show({ message: "Compacting conversation…", variant: "info" });
		try {
			const effective = resolveEffectiveAgentSelection(
				registry,
				agent,
				model,
				variant
			);
			const result = await compact(focus, effective.model);
			show({
				message: `Compacted ${result.entry.tokensBefore} → ${result.entry.tokensAfter} tokens.`,
				variant: "success",
			});
			return true;
		} catch (error) {
			show({
				message: error instanceof Error ? error.message : "Compaction failed.",
				variant: "error",
			});
			return false;
		}
	};

	const executeCompactionCommand = (focus?: string) =>
		runManualCompaction(focus);

	const submitMessage = async (submission: ChatPromptSubmission) => {
		const { files, text, skill } = submission;
		const userText = text.trim();
		if (!hasChatPromptContent(submission)) {
			return false;
		}
		if (!skill && files.length === 0) {
			if (isSettingsCommand(userText)) {
				openSettings();
				return true;
			}
			const compactCommand = parseCompactCommand(userText);
			if (compactCommand) {
				return executeCompactionCommand(compactCommand.focus);
			}
		}
		if (isTurnBusy || registry === null || !isPromptConfigRestored) {
			return false;
		}

		const effective = resolveEffectiveAgentSelection(
			registry,
			agent,
			model,
			variant
		);
		const outcome = await send({
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
	const observedCompactionCountRef = useRef(initialCompactions.length);
	useEffect(() => {
		const observed = observedCompactionCountRef.current;
		if (compactions.length <= observed) {
			observedCompactionCountRef.current = compactions.length;
			return;
		}
		const added = compactions.slice(observed);
		observedCompactionCountRef.current = compactions.length;
		for (const entry of added) {
			if (entry.trigger === "manual") {
				continue;
			}
			show({
				message: `Automatic compaction (${entry.trigger}): ${entry.tokensBefore} → ${entry.tokensAfter} tokens.`,
				variant: "success",
			});
		}
	}, [compactions, show]);

	useEffect(() => {
		if (catalogDiagnostic !== null) {
			show({ message: catalogDiagnostic, variant: "error" });
		}
	}, [catalogDiagnostic, show]);

	useEffect(() => {
		const lastInitialMessage = initialMessages.at(-1);

		if (
			registry === null ||
			!isPromptConfigRestored ||
			!(
				lastInitialMessage &&
				shouldAutoStartAssistantTurn(autoStart, lastInitialMessage)
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
		send({
			agent: effective.agent,
			conversationModel,
			conversationVariant,
			messageId: lastInitialMessage.id,
			model: effective.model,
			resolvedAgent: effective.resolvedAgent,
			variant: effective.variant,
		})
			.then((outcome) => {
				if (outcome?.rejected) {
					show({ message: outcome.reason, variant: "error" });
				}
			})
			.catch(() => undefined);
	}, [
		agent,
		autoStart,
		initialMessages,
		isPromptConfigRestored,
		model,
		registry,
		restoredConfig,
		send,
		variant,
		show,
	]);

	return (
		<box flexDirection="row" height="100%" width="100%">
			<box flexGrow={1} height="100%" paddingX={1}>
				<ChatShell
					compactions={compactions}
					error={error}
					isBusy={isBusy}
					isInterruptArmed={isInterruptArmed}
					messages={messages}
					onCompact={executeCompactionCommand}
					onOpenSettings={openSettings}
					onSubmit={submitMessage}
					promptHistory={promptHistory}
				/>
			</box>
		</box>
	);
}
