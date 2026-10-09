import { useKeyboard } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import type { AgentId, SessionMessageId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	normalizeChatModelSelection,
	normalizeThinkingSelection,
	type ThinkingSelection,
} from "@wincode/ai/models";
import {
	getErrorMessage,
	isNull,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentRegistry,
	resolveEffectiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { SessionHost } from "@/modules/sessions/host/types";
import {
	createSessionUserMessage,
	type SessionFilePart,
	type SessionMessage,
} from "@/modules/sessions/message";
import { useSettingsHubDialog } from "@/modules/settings";
import type { EditMode } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import type { SessionWaitingMessage } from "../../agent-session/types";
import { isSessionBusy } from "../../agent-session/utils";
import { derivePromptHistory } from "../../hooks/input-controller/history";
import { useAgentSession } from "../../hooks/use-agent-session";
import type { ResolvedSessionSelection } from "../../selection";
import { getSessionStore } from "../../storage/get-session-store";
import type {
	SessionSubmissionComposition,
	SessionSendInput as SessionSubmissionInput,
} from "../../submission-types";
import type { ChatPromptSubmission } from "../../utils";
import { ChatShell } from "../components/chat-shell";
import { RenameSessionDialog } from "../dialogs/rename-session-dialog";

const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 3000;

export type SessionInitialSubmission = {
	messageId: SessionMessageId;
};

type SessionViewProps = {
	/** The already-open session this view renders and sends through. */
	host: SessionHost;
	initialSubmission?: SessionInitialSubmission;
	/**
	 * Session Transcript as the session opened, display-annotated by the
	 * surface: the prompt history and the first turn's message come from what
	 * the session was opened with, not from what it has streamed since.
	 */
	initialTranscript: readonly SessionMessage[];
	sessionId: SessionId;
	sessionTitle: string;
};

type SessionSendInput = Pick<
	SessionSubmissionInput,
	| "agent"
	| "sessionModel"
	| "sessionThinkingLevel"
	| "model"
	| "resolvedAgent"
	| "thinkingLevel"
>;

type SessionSelectionInput = {
	agent: AgentId;
	initialMessage: SessionMessage;
	model: ChatModelSelection;
	registry: AgentRegistry;
	restoredConfig: ResolvedSessionSelection | null;
	thinkingSelection: ThinkingSelection;
};

type RecallKeyEvent = {
	meta: boolean;
	name: string;
	option: boolean;
	preventDefault: () => void;
	shift: boolean;
};

const resolveInitialSessionSelection = ({
	agent,
	initialMessage,
	model,
	registry,
	restoredConfig,
	thinkingSelection,
}: SessionSelectionInput): SessionSendInput => {
	const resolvedModel =
		normalizeChatModelSelection(initialMessage.metadata?.model ?? model) ??
		model;
	const sessionModel = restoredConfig?.model ?? model;
	const sessionThinkingLevel =
		restoredConfig?.thinkingLevel ?? thinkingSelection.thinkingLevel;
	const sessionThinkingSelection = normalizeThinkingSelection(
		sessionModel,
		sessionThinkingLevel === undefined
			? {}
			: { thinkingLevel: sessionThinkingLevel }
	);
	const persistedThinkingLevel =
		restoredConfig?.thinkingLevel ?? initialMessage.metadata?.thinkingLevel;
	const persistedSelection = normalizeThinkingSelection(
		resolvedModel,
		persistedThinkingLevel === undefined
			? {}
			: { thinkingLevel: persistedThinkingLevel }
	);
	const persistedAgentId =
		initialMessage.metadata?.agent ?? restoredConfig?.agent ?? agent;
	const persistedSubagentIsAvailable =
		restoredConfig?.agent === persistedAgentId &&
		registry.agents.some(
			({ id, isAvailable, role }) =>
				id === persistedAgentId && isAvailable && role === "subagent"
		);
	const persistedAgentIsAvailable =
		persistedSubagentIsAvailable ||
		registry.selectableAgents.some(
			({ id, isAvailable }) => id === persistedAgentId && isAvailable
		);
	const effective = resolveEffectiveAgentSelection(
		registry,
		persistedAgentId,
		persistedAgentIsAvailable ? resolvedModel : sessionModel,
		persistedAgentIsAvailable ? persistedSelection : sessionThinkingSelection,
		persistedSubagentIsAvailable
	);
	return {
		agent: effective.agent,
		sessionModel,
		sessionThinkingLevel: sessionThinkingSelection.thinkingLevel,
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		...(effective.thinkingLevel === undefined
			? {}
			: { thinkingLevel: effective.thinkingLevel }),
	};
};

export function SessionView({
	host,
	initialSubmission,
	initialTranscript,
	sessionId,
	sessionTitle,
}: SessionViewProps) {
	const router = useRouter();
	const { agent, model, thinkingLevel, setAgent, setModel, setThinkingLevel } =
		usePromptConfig();
	const currentThinkingSelection = useMemo<ThinkingSelection>(
		() => (thinkingLevel === undefined ? {} : { thinkingLevel }),
		[thinkingLevel]
	);
	const registry = useAgentRegistry();
	const dialog = useDialog();
	const sessionStore = useMemo(() => getSessionStore(), []);
	const [editMode, setEditMode] = useState<EditMode>("hashline");
	const editModeLoadRevisionRef = useRef(0);
	const setSessionEditMode = useCallback((mode: EditMode) => {
		editModeLoadRevisionRef.current += 1;
		setEditMode(mode);
	}, []);
	const persistSessionEditMode = useCallback(
		async (mode: EditMode) => {
			if (sessionStore.setEditMode === undefined) {
				throw new Error("Session storage does not support Edit Mode.");
			}
			await sessionStore.setEditMode(sessionId, mode);
		},
		[sessionId, sessionStore]
	);
	useEffect(() => {
		let active = true;
		const loadRevision = ++editModeLoadRevisionRef.current;
		const loadEditMode = async (): Promise<void> => {
			try {
				const mode = await sessionStore.getEditMode?.(sessionId);
				if (
					active &&
					loadRevision === editModeLoadRevisionRef.current &&
					mode !== undefined
				) {
					setEditMode(mode);
				}
			} catch {
				return;
			}
		};
		void loadEditMode();
		return () => {
			active = false;
		};
	}, [sessionId, sessionStore]);
	const settingsRuntime = useMemo(
		() => ({
			editMode,
			model,
			onEditModeChanged: setSessionEditMode,
			sessionId,
			setEditMode: persistSessionEditMode,
		}),
		[editMode, model, persistSessionEditMode, sessionId, setSessionEditMode]
	);
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
		readonly SessionMessage[] | null
	>(null);
	const [recalledSubmissions, setRecalledSubmissions] = useState<
		readonly SessionSubmissionComposition[]
	>([]);
	const [recallRevision, setRecallRevision] = useState(0);
	const [optimisticMessages, setOptimisticMessages] = useState<
		readonly SessionMessage[]
	>([]);
	const {
		cancelCompaction,
		compact,
		onSubmissionEvent,
		interrupt,
		recallWaitingMessages,
		prompt,
		send,
		steer,
		snapshot,
	} = useAgentSession(host);
	/**
	 * Hands recalled messages to the composer in Agent Session order. A Recall
	 * that returns nothing — empty lanes, or messages already running — changes
	 * nothing.
	 */
	const recallIntoComposer = async (
		recalledPromise: Promise<readonly SessionWaitingMessage[]>
	): Promise<void> => {
		try {
			const recalled = await recalledPromise;
			if (recalled.length === 0) {
				return;
			}
			setRecalledSubmissions(recalled.map(({ input }) => input.composition));
			setRecallRevision((revision) => revision + 1);
		} catch (error) {
			show({
				message: getErrorMessage(
					error,
					"Could not recall waiting Submissions."
				),
				variant: "error",
			});
		}
	};
	useEffect(() => {
		const pending: SessionSubmissionComposition[] = [];
		let flushScheduled = false;
		let active = true;
		const unsubscribe = onSubmissionEvent((event) => {
			if (event.kind === "failed") {
				show({
					message: event.reason ?? "Submission failed.",
					variant: "error",
				});
				return;
			}
			if (
				event.kind !== "recalled" ||
				event.reason !== "turn-failed" ||
				event.composition === undefined
			) {
				return;
			}
			pending.push(event.composition);
			if (flushScheduled) {
				return;
			}
			flushScheduled = true;
			queueMicrotask(() => {
				flushScheduled = false;
				if (!active || pending.length === 0) {
					return;
				}
				setRecalledSubmissions(pending.splice(0));
				setRecallRevision((revision) => revision + 1);
			});
		});
		return () => {
			active = false;
			pending.length = 0;
			unsubscribe();
		};
	}, [onSubmissionEvent, show]);
	const activeMessages = snapshot.context;
	const displayAnnotationsByMessage = useMemo(() => {
		const annotations = new Map<
			SessionMessage["id"],
			readonly (SessionFilePart | undefined)[]
		>();
		for (const message of initialTranscript) {
			const parts = message.parts.map((part) =>
				part.type === "file" && part.displayAvailability === "missing"
					? part
					: undefined
			);
			if (parts.some((part) => part !== undefined)) {
				annotations.set(message.id, parts);
			}
		}
		return annotations;
	}, [initialTranscript]);
	const messages = useMemo(() => {
		const transcript = snapshot.transcript.map((message) => {
			const annotations = displayAnnotationsByMessage.get(message.id);
			if (annotations === undefined) {
				return message;
			}
			let hasAnnotation = false;
			const parts = message.parts.map((part, index) => {
				const annotation = annotations[index];
				if (
					part.type !== "file" ||
					annotation?.attachmentId === undefined ||
					part.attachmentId !== annotation.attachmentId
				) {
					return part;
				}
				hasAnnotation = true;
				return annotation;
			});
			return hasAnnotation ? { ...message, parts } : message;
		});
		if (optimisticMessages.length === 0) {
			return transcript;
		}
		const committedIds = new Set(snapshot.transcript.map(({ id }) => id));
		return [
			...transcript,
			...optimisticMessages.filter(({ id }) => !committedIds.has(id)),
		];
	}, [displayAnnotationsByMessage, optimisticMessages, snapshot.transcript]);
	const error = snapshot.compactionError ?? snapshot.error;
	// The session's own facts decide whether it is busy: a running turn or a
	// compaction in flight.
	const isBusy = isSessionBusy(snapshot) || isStartingInitialTurn;
	const promptHistory = useMemo(
		() => derivePromptHistory(initialTranscript),
		[initialTranscript]
	);
	const restoredConfig = useMemo<ResolvedSessionSelection | null>(
		// The Host resolves the selection against the live registry; while that
		// registry is still loading there is nothing to restore yet.
		() => (isNull(registry) ? null : host.getSelection()),
		[host, registry]
	);
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
		setThinkingLevel(restoredConfig.thinkingLevel);
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
		setThinkingLevel,
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
			void recallIntoComposer(interrupt());
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
	/**
	 * Keyboard Recall. `Alt` recalls the uncommitted Submission Queue; `Shift`
	 * recalls only its head. Committed Steering Messages are not recallable.
	 */
	const handleRecallKey = (key: RecallKeyEvent): boolean => {
		// Terminals encode Alt differently: a modified arrow arrives as a CSI
		// sequence (`option`), an Alt+letter as an escape prefix (`meta`). Recall
		// answers to either, so no terminal loses the binding.
		if ((key.option || key.meta) && (key.name === "up" || key.name === "z")) {
			key.preventDefault();
			void recallIntoComposer(recallWaitingMessages());
			return true;
		}
		if (!(key.shift && key.name === "up")) {
			return false;
		}
		key.preventDefault();
		// Only uncommitted queue entries can be recalled.
		const next = snapshot.queuedSubmissions[0];
		if (!isUndefined(next)) {
			void recallIntoComposer(recallWaitingMessages([next.id]));
		}
		return true;
	};

	useKeyboard((key) => {
		if (!isTopLayer("base")) {
			return;
		}
		if (handleRecallKey(key)) {
			return;
		}
		if (key.name === "escape") {
			if (snapshot.isCompacting) {
				key.preventDefault();
				void recallIntoComposer(cancelCompaction());
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
				currentThinkingSelection
			);
			const thinkingSelection: ThinkingSelection =
				effective.thinkingLevel === undefined
					? {}
					: { thinkingLevel: effective.thinkingLevel };
			await compact(focus, effective.model, thinkingSelection);
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
			currentThinkingSelection
		);
		const optimisticMessage = isBusy
			? undefined
			: createSessionUserMessage(
					userText,
					{
						agent: effective.agent,
						model: effective.model,
						...omitUndefined({
							thinkingLevel: effective.thinkingLevel,
						}),
					},
					[],
					files
				);
		if (optimisticMessage) {
			setOptimisticMessages((pending) => [...pending, optimisticMessage]);
		}
		// Prompt admission resets the composer without waiting for turn completion;
		// a busy session keeps the submission queued until explicitly steered.
		void prompt({
			agent: effective.agent,
			sessionModel: model,
			...(thinkingLevel === undefined
				? {}
				: { sessionThinkingLevel: thinkingLevel }),
			composition,
			files,
			model: effective.model,
			resolvedAgent: effective.resolvedAgent,
			...(effective.thinkingLevel === undefined
				? {}
				: { thinkingLevel: effective.thinkingLevel }),
			userText,
			reservedMessageId: optimisticMessage?.id,
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
			})
			.finally(() => {
				if (optimisticMessage) {
					setOptimisticMessages((pending) =>
						pending.filter(({ id }) => id !== optimisticMessage.id)
					);
				}
			});
		return true;
	};
	const steerQueuedHead = async () => {
		try {
			const admission = await steer();
			if (admission.kind === "rejected") {
				show({ message: admission.reason, variant: "error" });
			}
		} catch {
			show({
				message: "Could not steer the queued submission",
				variant: "error",
			});
		}
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
				thinkingSelection: currentThinkingSelection,
			}),
			messageId,
		});
		if (outcome.rejected) {
			show({ message: outcome.reason, variant: "error" });
		}
	};

	// The session's compaction history is what it opened with: only compactions
	// this view observes being added are announced.
	const observedCompactionCountRef = useRef(snapshot.compactions.length);
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
						thinkingSelection: currentThinkingSelection,
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
		currentThinkingSelection,
	]);

	return (
		<box flexDirection="row" height="100%" width="100%">
			<box flexGrow={1} height="100%" paddingX={1}>
				<ChatShell
					activeMessages={activeMessages}
					compactions={snapshot.compactions}
					draftKey={sessionId}
					error={error}
					isBusy={isBusy}
					isCompacting={snapshot.isCompacting}
					isInterruptArmed={isInterruptArmed}
					key={sessionId}
					messages={messages}
					onCompact={executeCompactionCommand}
					onEmptySubmit={steerQueuedHead}
					onOpenSettings={openSettings}
					onRetry={retryMessage}
					onSubmit={submitMessage}
					promptHistory={promptHistory}
					queuedSubmissions={snapshot.queuedSubmissions}
					recalledSubmissions={recalledSubmissions}
					recallRevision={recallRevision}
					viewId={sessionId}
				/>
			</box>
		</box>
	);
}
