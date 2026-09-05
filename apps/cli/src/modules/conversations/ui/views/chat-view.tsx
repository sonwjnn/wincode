import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import { type AgentId, createAgentTurnId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	type ModelVariant,
	normalizeChatModelSelection,
	normalizeModelVariant,
} from "@wincode/ai/models";
import { createSkillSnapshot } from "@wincode/skills";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentRegistry,
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import {
	type ConversationMessage,
	createConversationUserMessage,
} from "@/modules/conversations/message";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { McpActiveIndicator } from "@/modules/mcp";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useSettingsHubDialog } from "@/modules/settings";
import { APP_VERSION } from "@/shared/app-info";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import type { ApprovalOutcome } from "@/shared/providers/approval/types";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
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
	resolveLastUsedConversationSelection,
} from "../../selection";
import { projectConversationRecords } from "../../storage/conversation-record";
import type { PendingInitialTurn } from "../../storage/conversation-store";
import { getConversationStore } from "../../storage/get-conversation-store";
import { type ChatPromptSubmission, getMostRecentSession } from "../../utils";
import { AsciiArt } from "../components/ascii-art";
import { ChatShell } from "../components/chat-shell";
import { ChatTextArea } from "../components/chat-text-area";
import { WorkspacePath } from "../components/workspace-path";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

type ChatSessionViewProps = {
	mode: "session";
	initialActiveMessages?: ConversationMessage[];
	initialCompactions?: ConversationCompaction[];
	initialMessages: ConversationMessage[];
	initialModel?: ChatModelSelection;
	initialPendingTurn?: PendingInitialTurn;
	initialVariant?: ModelVariant;
	sessionId: string;
	sessionTitle: string;
};

type ChatHomeViewProps = {
	mode: "home";
};

type ChatViewProps = ChatHomeViewProps | ChatSessionViewProps;
type PendingTurnSendInput = Pick<
	ConversationSendInput,
	| "agent"
	| "conversationModel"
	| "conversationVariant"
	| "model"
	| "resolvedAgent"
	| "variant"
>;

type PendingTurnSelectionInput = {
	agent: AgentId;
	initialMessage: ConversationMessage;
	model: ChatModelSelection;
	registry: AgentRegistry;
	restoredConfig: ResolvedConversationSelection | null;
	variant?: ModelVariant;
};

const resolvePendingTurnSelection = ({
	agent,
	initialMessage,
	model,
	registry,
	restoredConfig,
	variant,
}: PendingTurnSelectionInput): PendingTurnSendInput => {
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

type HomePromptReadiness = {
	defaultAgentId: string | undefined;
	initializedDefaultAgentId: string | undefined;
	isCreatingSession: boolean;
	isPromptConfigRestored: boolean;
	registryReady: boolean;
};

export const canSubmitHomePrompt = ({
	defaultAgentId,
	initializedDefaultAgentId,
	isCreatingSession,
	isPromptConfigRestored,
	registryReady,
}: HomePromptReadiness): boolean =>
	!isCreatingSession &&
	isPromptConfigRestored &&
	registryReady &&
	initializedDefaultAgentId === defaultAgentId;

export const hasChatPromptContent = ({
	files,
	skill,
	text,
}: ChatPromptSubmission): boolean =>
	text.trim().length > 0 || files.length > 0 || skill !== undefined;

export function ChatView(props: ChatViewProps) {
	if (props.mode === "home") {
		return <HomeChatView />;
	}
	return <SessionChatView {...props} />;
}

function SessionChatView({
	initialMessages,
	initialActiveMessages = initialMessages,
	initialCompactions = [],
	initialModel,
	initialPendingTurn,
	initialVariant,
	sessionId,
	sessionTitle,
}: ChatSessionViewProps) {
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
		const pending = initialPendingTurn;
		const initialMessage = pending?.message;

		if (
			registry === null ||
			!isPromptConfigRestored ||
			pending?.state !== "pending" ||
			initialMessage === undefined ||
			initialMessage.role !== "user" ||
			!initialMessages.some(({ id }) => id === initialMessage.id)
		) {
			return;
		}

		if (submittedInitialMessageRef.current === initialMessage.id) {
			return;
		}

		const startPendingTurn = async () => {
			const store = getConversationStore();
			const claimed = await store.claimPendingInitialTurn(
				sessionId,
				pending.turnId
			);
			if (!claimed) {
				return;
			}

			submittedInitialMessageRef.current = initialMessage.id;
			const outcome = await send({
				...resolvePendingTurnSelection({
					agent,
					initialMessage,
					model,
					registry,
					restoredConfig,
					variant,
				}),
				messageId: initialMessage.id,
				turnId: pending.turnId,
			});
			if (!outcome.rejected) {
				return;
			}

			try {
				await store.releasePendingInitialTurn(sessionId, pending.turnId);
			} catch {
				show({
					message: "Could not reset the initial turn; it remains claimed.",
					variant: "error",
				});
			}
			show({ message: outcome.reason, variant: "error" });
		};

		startPendingTurn().catch((error: unknown) => {
			show({
				message:
					error instanceof Error
						? error.message
						: "Could not resume the initial turn.",
				variant: "error",
			});
		});
	}, [
		agent,
		initialMessages,
		initialPendingTurn,
		isPromptConfigRestored,
		model,
		registry,
		restoredConfig,
		send,
		sessionId,
		show,
		variant,
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
					onApproval={routeApproval}
					onCompact={executeCompactionCommand}
					onOpenSettings={openSettings}
					onSubmit={submitMessage}
					promptHistory={promptHistory}
					viewState={viewState}
				/>
			</box>
		</box>
	);
}
function HomeChatView() {
	const router = useRouter();
	const [_error, setError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [isPromptConfigRestored, setIsPromptConfigRestored] = useState(false);
	const [initializedDefaultAgentId, setInitializedDefaultAgentId] = useState<
		string | undefined
	>();
	const { agent, model, setAgent, setModel, setVariant, variant } =
		usePromptConfig();
	const openSettings = useSettingsHubDialog();
	const { colors } = useTheme();
	const { show } = useToast();
	const registry = useAgentRegistry();
	const defaultAgentId = registry?.defaultAgentId;

	useEffect(() => {
		if (defaultAgentId !== undefined) {
			setAgent(defaultAgentId);
			setInitializedDefaultAgentId(defaultAgentId);
		}
	}, [defaultAgentId, setAgent]);

	useEffect(() => {
		if (registry === null) {
			setIsPromptConfigRestored(false);
			return;
		}
		let ignore = false;
		setIsPromptConfigRestored(false);

		const restoreLatestSessionConfig = async () => {
			try {
				const store = getConversationStore();
				const session = getMostRecentSession(await store.listSessions());
				if (!session) {
					return;
				}

				const selection = resolveLastUsedConversationSelection({
					messages: projectConversationRecords(
						await store.listConversationRecords(session.id)
					),
					resolveAgent: (agentId) => resolveActiveAgentId(registry, agentId),
					sessionModel: session.model,
					sessionVariant: session.variant,
				});
				if (ignore || !selection) {
					return;
				}
				if (selection.agent !== undefined) {
					setAgent(selection.agent);
				}

				setModel(selection.model);
				setVariant(selection.variant);
			} finally {
				if (!ignore) {
					setIsPromptConfigRestored(true);
				}
			}
		};

		restoreLatestSessionConfig().catch(() => undefined);

		return () => {
			ignore = true;
		};
	}, [registry, setAgent, setModel, setVariant]);

	const handleSubmit = async ({ files, skill, text }: ChatPromptSubmission) => {
		const prompt = text.trim();
		if (!skill && files.length === 0) {
			if (isSettingsCommand(prompt)) {
				openSettings();
				return true;
			}
			if (parseCompactCommand(prompt)) {
				show({
					message: "Compaction is unavailable without an active session.",
					variant: "error",
				});
				return false;
			}
		}
		if (
			!canSubmitHomePrompt({
				defaultAgentId,
				initializedDefaultAgentId,
				isCreatingSession,
				isPromptConfigRestored,
				registryReady: registry !== null,
			})
		) {
			return false;
		}

		if (!(prompt || files.length > 0)) {
			return false;
		}

		setError(null);
		setIsCreatingSession(true);

		try {
			await createSession(prompt, files, skill);
			return true;
		} catch {
			setError("Could not create chat session.");
			return false;
		} finally {
			setIsCreatingSession(false);
		}
	};

	const createSession = async (
		input: string,
		files: ChatPromptSubmission["files"],
		skill: ChatPromptSubmission["skill"]
	) => {
		const fileMentions = await resolveFileMentionParts(input);
		const effective = resolveEffectiveAgentSelection(
			registry,
			agent,
			model,
			variant
		);
		const initialMessage = createConversationUserMessage(
			input,
			{
				agent: effective.agent,
				model: effective.model,
				variant: effective.variant,
				...(skill ? { skill: createSkillSnapshot(skill, "explicit") } : {}),
			},
			fileMentions,
			files
		);
		const store = getConversationStore();
		const [externalized] = await store.externalizeAttachments(
			[initialMessage],
			undefined,
			{ rejectInvalid: true }
		);
		const durableMessage = externalized ?? initialMessage;
		const { id } = await store.createSession({
			agent: effective.agent,
			initialTurnId: createAgentTurnId(),
			message: durableMessage,
			model,
			variant,
		});
		await router.navigate({
			params: { id },
			to: "/sessions/$id",
		});
	};

	return (
		<box flexDirection="column" height="100%" width="100%">
			<box
				alignItems="center"
				flexGrow={1}
				gap={2}
				justifyContent="center"
				position="relative"
				width="100%"
			>
				<AsciiArt />
				<box
					flexDirection="column"
					gap={1}
					maxWidth={78}
					paddingX={2}
					width="100%"
				>
					<ChatTextArea
						disabled={isCreatingSession}
						onOpenSettings={openSettings}
						onSubmit={handleSubmit}
						showCompactCommand={false}
					/>
					<box
						flexDirection="row"
						flexShrink={0}
						gap={2}
						justifyContent="space-between"
						width="100%"
					>
						<WorkspacePath />
						<box flexDirection="row" flexShrink={0} gap={1}>
							<text fg={colors.text}>tab</text>
							<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
								agents
							</text>
						</box>
					</box>
				</box>
			</box>

			<box
				alignItems="center"
				flexDirection="row"
				flexShrink={0}
				gap={2}
				justifyContent="space-between"
				paddingBottom={1}
				paddingX={2}
				width="100%"
			>
				<McpActiveIndicator />
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					{`v${APP_VERSION}`}
				</text>
			</box>
		</box>
	);
}
