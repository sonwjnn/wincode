import { useKeyboard } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import type { AgentId, SessionMessageId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	type ModelVariant,
	normalizeChatModelSelection,
	normalizeModelVariant,
} from "@wincode/ai/models";
import { getErrorMessage, isNull, isUndefined } from "@wincode/runtime-utils";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentRegistry,
	resolveActiveAgentId,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { SessionMessage } from "@/modules/sessions/message";
import { useSettingsHubDialog } from "@/modules/settings";
import type { SessionId } from "@/shared/identifiers";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import type { SessionCompaction } from "../../compaction";
import type { SessionQueuedSubmission } from "../../engine/types";
import { isSessionBusy } from "../../engine/utils";
import { derivePromptHistory } from "../../hooks/input-controller/history";
import { useSessionEngine } from "../../hooks/use-session-engine";
import {
	type ResolvedSessionSelection,
	resolveSessionSelection,
} from "../../selection";
import type {
	SessionSendInput as SessionOperationSendInput,
	SessionSubmissionComposition,
} from "../../session-operation";
import type { ChatPromptSubmission } from "../../utils";
import { ChatShell } from "../components/chat-shell";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

export type SessionInitialSubmission = {
	messageId: SessionMessageId;
};

type SessionViewProps = {
	initialCompactions?: SessionCompaction[];
	initialContext?: SessionMessage[];
	initialTranscript: SessionMessage[];
	initialModel?: ChatModelSelection;
	initialSubmission?: SessionInitialSubmission;
	initialVariant?: ModelVariant;
	sessionId: SessionId;
	sessionTitle: string;
};

type SessionSendInput = Pick<
	SessionOperationSendInput,
	| "agent"
	| "sessionModel"
	| "sessionVariant"
	| "model"
	| "resolvedAgent"
	| "variant"
>;

type SessionSelectionInput = {
	agent: AgentId;
	initialMessage: SessionMessage;
	model: ChatModelSelection;
	registry: AgentRegistry;
	restoredConfig: ResolvedSessionSelection | null;
	variant?: ModelVariant;
};

const resolveInitialSessionSelection = ({
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
	const sessionModel = restoredConfig?.model ?? model;
	const sessionVariant = restoredConfig?.variant ?? variant;
	const persistedAgentId =
		initialMessage.metadata?.agent ?? restoredConfig?.agent ?? agent;
	const persistedAgentIsAvailable = registry.selectableAgents.some(
		({ id, isAvailable }) => id === persistedAgentId && isAvailable
	);
	const effective = resolveEffectiveAgentSelection(
		registry,
		persistedAgentId,
		persistedAgentIsAvailable ? resolvedModel : sessionModel,
		persistedAgentIsAvailable ? persistedVariant : sessionVariant
	);
	return {
		agent: effective.agent,
		sessionModel,
		sessionVariant,
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		variant: effective.variant,
	};
};

export function SessionView({
	initialTranscript,
	initialContext = initialTranscript,
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
	const submittedInitialMessageRef = useRef<SessionMessageId | null>(null);
	const interruptResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	const interruptArmedRef = useRef(false);
	const [isInterruptArmed, setIsInterruptArmed] = useState(false);
	const [isStartingInitialTurn, setIsStartingInitialTurn] = useState(
		!isUndefined(initialSubmission)
	);
	const [restoredMessages, setRestoredMessages] = useState<
		SessionMessage[] | null
	>(null);
	const [recalledSubmissions, setRecalledSubmissions] = useState<
		readonly SessionSubmissionComposition[]
	>([]);
	const [recallRevision, setRecallRevision] = useState(0);
	const {
		cancelCompaction,
		compact,
		interrupt,
		recallQueuedSubmissions,
		send,
		snapshot,
	} = useSessionEngine(
		sessionId,
		initialTranscript,
		initialContext,
		initialCompactions
	);
	/**
	 * Hands recalled submissions to the composer. A Recall that returns
	 * nothing — an empty queue, or submissions that already started running —
	 * changes nothing.
	 */
	const recallIntoComposer = (recalled: readonly SessionQueuedSubmission[]) => {
		if (recalled.length === 0) {
			return;
		}
		setRecalledSubmissions(recalled.map(({ input }) => input.composition));
		setRecallRevision((revision) => revision + 1);
	};
	const activeMessages = snapshot.context;
	const messages = snapshot.transcript;
	const error = snapshot.compactionError ?? snapshot.error;
	// The session's own facts decide whether it is busy: a running turn, an
	// approval that is waiting, or a compaction in flight.
	const isBusy = isSessionBusy(snapshot) || isStartingInitialTurn;
	const promptHistory = useMemo(
		() => derivePromptHistory(initialTranscript),
		[initialTranscript]
	);
	const restoredConfig = useMemo(() => {
		if (isNull(registry)) {
			return null;
		}
		return resolveSessionSelection({
			messages: initialTranscript,
			resolveAgent: (agentId) => resolveActiveAgentId(registry, agentId),
			sessionModel: initialModel,
			sessionVariant: initialVariant,
		});
	}, [initialTranscript, initialModel, initialVariant, registry]);
	const isPromptConfigRestored = restoredMessages === initialTranscript;

	useEffect(() => {
		if (isNull(registry)) {
			return;
		}
		if (!restoredConfig) {
			setRestoredMessages(initialTranscript);
			return;
		}

		if (restoredConfig.agent) {
			setAgent(restoredConfig.agent);
		}
		setModel(restoredConfig.model);
		setVariant(restoredConfig.variant);
		setRestoredMessages(initialTranscript);
		if (
			!isUndefined(restoredConfig.persistedAgent) &&
			restoredConfig.agent !== restoredConfig.persistedAgent
		) {
			show({
				message: `Saved Agent "${restoredConfig.persistedAgent}" is unavailable. Using Build.`,
				variant: "error",
			});
		}
	}, [
		initialTranscript,
		registry,
		restoredConfig,
		setAgent,
		setModel,
		setVariant,
		show,
	]);

	const handleInterrupt = () => {
		if (interruptArmedRef.current) {
			if (interruptResetTimeoutRef.current) {
				clearTimeout(interruptResetTimeoutRef.current);
				interruptResetTimeoutRef.current = null;
			}

			interruptArmedRef.current = false;
			setIsInterruptArmed(false);
			recallIntoComposer(interrupt());
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
		// Terminals encode Alt differently: a modified arrow arrives as a CSI
		// sequence (`option`), an Alt+letter as an escape prefix (`meta`). Recall
		// answers to either, so no terminal loses the binding.
		if ((key.option || key.meta) && (key.name === "up" || key.name === "z")) {
			key.preventDefault();
			recallIntoComposer(recallQueuedSubmissions());
			return;
		}
		if (key.name === "escape") {
			if (snapshot.isCompacting) {
				key.preventDefault();
				recallIntoComposer(cancelCompaction());
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
		if (isBusy || isNull(registry) || !isPromptConfigRestored) {
			show({
				message: "Compaction is unavailable while the session is active.",
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
				message: getErrorMessage(error, "Compaction failed."),
				variant: "error",
			});
			return false;
		}
	};

	const executeCompactionCommand = (focus?: string) =>
		runManualCompaction(focus);

	const submitMessage = async (submission: ChatPromptSubmission) => {
		const { composition, files, text, skill } = submission;
		const userText = text.trim();
		if (text.trim().length === 0 && files.length === 0 && isUndefined(skill)) {
			return false;
		}
		if (isNull(registry) || !isPromptConfigRestored) {
			return false;
		}

		const effective = resolveEffectiveAgentSelection(
			registry,
			agent,
			model,
			variant
		);
		// `send` resolves when the full turn completes; the composer should reset
		// as soon as this session accepts the new send, and a busy session accepts
		// it as a Queued Submission.
		void send({
			agent: effective.agent,
			sessionModel: model,
			sessionVariant: variant,
			composition,
			files,
			model: effective.model,
			resolvedAgent: effective.resolvedAgent,
			variant: effective.variant,
			userText,
			skill,
		})
			.then((outcome) => {
				if (outcome.rejected) {
					show({
						message: outcome.reason,
						variant: "error",
					});
				}
			})
			.catch(() => {
				show({
					message: "Could not submit the prompt",
					variant: "error",
				});
			});
		return true;
	};

	const retryMessage = async (messageId: SessionMessageId): Promise<void> => {
		if (isBusy || isNull(registry) || !isPromptConfigRestored) {
			return;
		}
		const initialMessage = messages.find(({ id }) => id === messageId);
		if (initialMessage?.role !== "user") {
			return;
		}
		const outcome = await send({
			...resolveInitialSessionSelection({
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

	const observedCompactionCountRef = useRef(initialCompactions.length);
	useEffect(() => {
		const observed = observedCompactionCountRef.current;
		if (snapshot.compactions.length <= observed) {
			observedCompactionCountRef.current = snapshot.compactions.length;
			return;
		}
		const added = snapshot.compactions.slice(observed);
		observedCompactionCountRef.current = snapshot.compactions.length;
		for (const entry of added) {
			if (entry.trigger === "manual") {
				continue;
			}
			show({
				message: `Automatic compaction (${entry.trigger}): ${entry.tokensBefore} → ${entry.estimatedTokensAfter} tokens.`,
				variant: "success",
			});
		}
	}, [snapshot.compactions, show]);

	useEffect(() => {
		if (!isNull(snapshot.catalogDiagnostic)) {
			show({ message: snapshot.catalogDiagnostic, variant: "error" });
		}
	}, [snapshot.catalogDiagnostic, show]);

	useEffect(() => {
		const submission = initialSubmission;
		const initialMessage = submission
			? initialTranscript.find(({ id }) => id === submission.messageId)
			: undefined;

		if (isUndefined(submission)) {
			if (isNull(submittedInitialMessageRef.current)) {
				setIsStartingInitialTurn(false);
			}
			return;
		}

		if (isUndefined(initialMessage) || initialMessage.role !== "user") {
			setIsStartingInitialTurn(false);
			return;
		}

		if (isNull(registry) || !isPromptConfigRestored) {
			return;
		}

		if (submittedInitialMessageRef.current === initialMessage.id) {
			return;
		}

		submittedInitialMessageRef.current = initialMessage.id;
		setIsStartingInitialTurn(true);
		const startInitialTurn = async (): Promise<void> => {
			try {
				await router.navigate({
					params: { id: sessionId },
					replace: true,
					state: {},
					to: "/sessions/$id",
				});
				const outcome = await send({
					...resolveInitialSessionSelection({
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
			} finally {
				setIsStartingInitialTurn(false);
			}
		};

		startInitialTurn().catch((error: unknown) => {
			show({
				message: getErrorMessage(error, "Could not start the Agent Turn."),
				variant: "error",
			});
		});
	}, [
		agent,
		initialTranscript,
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
					compactions={snapshot.compactions}
					error={error}
					isBusy={isBusy}
					isCompacting={snapshot.isCompacting}
					isInterruptArmed={isInterruptArmed}
					messages={messages}
					onCompact={executeCompactionCommand}
					onOpenSettings={openSettings}
					onRetry={retryMessage}
					onSubmit={submitMessage}
					promptHistory={promptHistory}
					queuedSubmissions={snapshot.queuedSubmissions}
					recalledSubmissions={recalledSubmissions}
					recallRevision={recallRevision}
					viewState={snapshot.viewState}
				/>
			</box>
		</box>
	);
}
