import { useKeyboard } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	type ModelVariant,
	normalizeChatModelSelection,
	normalizeModelVariant,
} from "@wincode/ai/models";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentRegistry,
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import type { ConversationMessage } from "@/modules/conversations/message";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useSettingsHubDialog } from "@/modules/settings";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import type { ApprovalOutcome } from "@/shared/providers/approval/types";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import {
	type ConversationCompaction,
	isSettingsCommand,
	parseCompactCommand,
} from "../../compaction";
import type { ConversationSendInput } from "../../conversation-operation";
import { derivePromptHistory } from "../../hooks/input-controller/history";
import { useChat } from "../../hooks/use-chat";
import {
	type ResolvedConversationSelection,
	resolveConversationSelection,
} from "../../selection";
import type { ChatPromptSubmission } from "../../utils";
import { ChatShell } from "../components/chat-shell";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

export type SessionInitialSubmission = {
	messageId: string;
};

type SessionViewProps = {
	initialActiveMessages?: ConversationMessage[];
	initialCompactions?: ConversationCompaction[];
	initialMessages: ConversationMessage[];
	initialModel?: ChatModelSelection;
	initialSubmission?: SessionInitialSubmission;
	initialVariant?: ModelVariant;
	sessionId: string;
	sessionTitle: string;
};

type SessionSendInput = Pick<
	ConversationSendInput,
	| "agent"
	| "conversationModel"
	| "conversationVariant"
	| "model"
	| "resolvedAgent"
	| "variant"
>;

type SessionSelectionInput = {
	agent: AgentId;
	initialMessage: ConversationMessage;
	model: ChatModelSelection;
	registry: AgentRegistry;
	restoredConfig: ResolvedConversationSelection | null;
	variant?: ModelVariant;
};

const resolveSessionSelection = ({
	agent,
	initialMessage,
	model,
	registry,
	restoredConfig,
	variant,
}: SessionSelectionInput): SessionSendInput => {
	const resolvedModel =
		normalizeChatModelSelection(initialMessage.metadata?.model ?? model) ??
		model;
	const persistedVariant = normalizeModelVariant(
		resolvedModel,
		restoredConfig?.variant ?? initialMessage.metadata?.variant
	);
	const conversationModel = restoredConfig?.model ?? model;
	const conversationVariant = restoredConfig?.variant ?? variant;
	const persistedAgentId =
		initialMessage.metadata?.agent ?? restoredConfig?.agent ?? agent;
	const persistedAgentIsAvailable = registry.selectableAgents.some(
		({ id, isAvailable }) => id === persistedAgentId && isAvailable
	);
	const effective = resolveEffectiveAgentSelection(
		registry,
		persistedAgentId,
		persistedAgentIsAvailable ? resolvedModel : conversationModel,
		persistedAgentIsAvailable ? persistedVariant : conversationVariant
	);
	return {
		agent: effective.agent,
		conversationModel,
		conversationVariant,
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		variant: effective.variant,
	};
};

export function SessionView({
	initialMessages,
	initialActiveMessages = initialMessages,
	initialCompactions = [],
	initialModel,
	initialSubmission,
	initialVariant,
	sessionId,
	sessionTitle,
}: SessionViewProps) {
	const router = useRouter();
	const { agent, model, setAgent, setModel, setVariant, variant } =
		usePromptConfig();
	const settingsRuntime = useMemo(
		() => ({ model, sessionId }),
		[model, sessionId]
	);
	const registry = useAgentRegistry();
	const dialog = useDialog();
	const { show } = useToast();
	const openSettings = useSettingsHubDialog(settingsRuntime);
	const { isTopLayer } = useKeyboardLayer();
	const { entries: approvalEntries, resolve: resolveApprovalPanel } =
		useApprovalPanels();
	const hasPendingApproval = approvalEntries.some(
		(entry) => entry.resolution === undefined
	);
	const submittedInitialMessageRef = useRef<string | null>(null);
	const interruptResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	const interruptArmedRef = useRef(false);
	const [isInterruptArmed, setIsInterruptArmed] = useState(false);
	const [restoredMessages, setRestoredMessages] = useState<
		ConversationMessage[] | null
	>(null);
	const {
		activeMessages,
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
		viewState,
	} = useChat(
		sessionId,
		initialMessages,
		initialActiveMessages,
		initialCompactions
	);
	const { cancel, interrupt, send } = conversation;
	const isTurnBusy =
		hasPendingApproval || isPreparingMessage || status !== "ready";
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
		try {
			const effective = resolveEffectiveAgentSelection(
				registry,
				agent,
				model,
				variant
			);
			await compact(focus, effective.model, effective.variant);
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
		if (text.trim().length === 0 && files.length === 0 && skill === undefined) {
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
			show({
				message: outcome.reason,
				variant: "error",
			});
			return false;
		}
		return true;
	};

	const retryMessage = async (messageId: string): Promise<void> => {
		if (
			isTurnBusy ||
			isCompacting ||
			registry === null ||
			!isPromptConfigRestored
		) {
			return;
		}
		const initialMessage = messages.find(({ id }) => id === messageId);
		if (initialMessage?.role !== "user") {
			return;
		}
		const outcome = await send({
			...resolveSessionSelection({
				agent,
				initialMessage,
				model,
				registry,
				restoredConfig,
				variant,
			}),
			messageId,
		});
		if (outcome.rejected) {
			show({ message: outcome.reason, variant: "error" });
		}
	};

	const routeApproval = (id: string, outcome: ApprovalOutcome): void => {
		let controllerOutcome:
			| { decision: "allow"; remember: boolean }
			| { decision: "reject"; feedback?: string }
			| { decision: "abort" };
		switch (outcome) {
			case "allow-once":
				controllerOutcome = { decision: "allow", remember: false };
				break;
			case "always":
				controllerOutcome = { decision: "allow", remember: true };
				break;
			case "rejected":
				controllerOutcome = { decision: "reject" };
				break;
			default:
				controllerOutcome = { decision: "abort" };
		}
		resolveApprovalPanel(id, outcome);
		void conversation.respondToApproval(id, controllerOutcome);
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
				message: `Automatic compaction (${entry.trigger}): ${entry.tokensBefore} → ${entry.estimatedTokensAfter} tokens.`,
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
		const submission = initialSubmission;
		const initialMessage = submission
			? initialMessages.find(({ id }) => id === submission.messageId)
			: undefined;

		if (
			registry === null ||
			!isPromptConfigRestored ||
			initialMessage === undefined ||
			initialMessage.role !== "user"
		) {
			return;
		}

		if (submittedInitialMessageRef.current === initialMessage.id) {
			return;
		}

		submittedInitialMessageRef.current = initialMessage.id;
		const startInitialTurn = async (): Promise<void> => {
			await router.navigate({
				params: { id: sessionId },
				replace: true,
				state: {},
				to: "/sessions/$id",
			});
			const outcome = await send({
				...resolveSessionSelection({
					agent,
					initialMessage,
					model,
					registry,
					restoredConfig,
					variant,
				}),
				messageId: initialMessage.id,
			});
			if (outcome.rejected) {
				show({ message: outcome.reason, variant: "error" });
			}
		};

		startInitialTurn().catch((error: unknown) => {
			show({
				message:
					error instanceof Error
						? error.message
						: "Could not start the Agent Turn.",
				variant: "error",
			});
		});
	}, [
		agent,
		initialMessages,
		initialSubmission,
		isPromptConfigRestored,
		model,
		registry,
		restoredConfig,
		router,
		send,
		sessionId,
		show,
		variant,
	]);

	return (
		<box flexDirection="row" height="100%" width="100%">
			<box flexGrow={1} height="100%" paddingX={1}>
				<ChatShell
					activeMessages={activeMessages}
					compactions={compactions}
					error={error}
					isBusy={isBusy}
					isCompacting={isCompacting}
					isInterruptArmed={isInterruptArmed}
					messages={messages}
					onApproval={routeApproval}
					onCompact={executeCompactionCommand}
					onOpenSettings={openSettings}
					onRetry={retryMessage}
					onSubmit={submitMessage}
					promptHistory={promptHistory}
					viewState={viewState}
				/>
			</box>
		</box>
	);
}
