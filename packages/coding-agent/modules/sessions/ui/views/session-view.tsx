import { useKeyboard } from "@opentui/react";
import { useRouter } from "@tanstack/react-router";
import type { AgentId, SessionMessageId } from "@wincode/agent-core";
import type { ProviderModel, ThinkingSelection } from "@wincode/ai";
import {
	getErrorMessage,
	isNull,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentRegistry,
	type AgentSelectionOverride,
	type EffectiveAgentSelection,
	resolveInteractiveAgentSelection,
	useAgentRegistry,
	withAvailableAgentModelOverride,
} from "@/modules/agents";
import { ProjectTrustNotice } from "@/modules/project-trust/ui/project-trust-notice";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	isSameProviderModelIdentity,
	normalizeProviderModelSelection,
	normalizeProviderModelThinkingSelection,
	type PluginProviderOwnerRegistration,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
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
import { getInteractivePluginRuntime } from "@/shared/runtime-context";
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
	| "selectionOverride"
	| "thinkingLevel"
>;

type SessionSelectionInput = {
	agent: AgentId;
	initialMessage: SessionMessage;
	model: ProviderModelSelection;
	registry: AgentRegistry;
	restoredConfig: ResolvedSessionSelection | null;
	selectionOverride: AgentSelectionOverride;
	thinkingSelection: ThinkingSelection;
	trustedProviderRegistrations: readonly PluginProviderOwnerRegistration[];
	hostProviderRegistrations?: (
		providerId: string
	) => readonly PluginProviderOwnerRegistration[] | undefined;
};

type RecallKeyEvent = {
	meta: boolean;
	name: string;
	option: boolean;
	preventDefault: () => void;
	shift: boolean;
};

const resolveInteractiveSubmissionSelection = async ({
	agent,
	fallbackModel,
	hostProviderRegistrations,
	assertProviderSnapshot,
	providerController,
	registry,
	restoredModel,
	selectionOverride,
	thinkingSelection,
	trustedProviderRegistrations,
}: {
	agent: AgentId;
	fallbackModel: ProviderModelSelection;
	hostProviderRegistrations?: (
		providerId: string
	) => readonly PluginProviderOwnerRegistration[] | undefined;
	assertProviderSnapshot: () => void;
	providerController: InteractiveProviderController | undefined;
	registry: AgentRegistry;
	restoredModel?: ProviderModelSelection;
	selectionOverride: AgentSelectionOverride | undefined;
	thinkingSelection: ThinkingSelection;
	trustedProviderRegistrations: readonly PluginProviderOwnerRegistration[];
}): Promise<{
	effective: EffectiveAgentSelection;
	selectionOverride: AgentSelectionOverride;
}> => {
	assertProviderSnapshot();
	const effective = resolveInteractiveAgentSelection(
		registry,
		agent,
		fallbackModel,
		thinkingSelection,
		selectionOverride,
		trustedProviderRegistrations,
		restoredModel,
		false,
		hostProviderRegistrations
	);
	if (effective.unavailableReason !== undefined) {
		throw new Error(effective.unavailableReason);
	}
	const availableProviderModels =
		providerController === undefined
			? undefined
			: await providerController.getAvailableModels(effective.model.providerId);
	assertProviderSnapshot();
	const availableSelectionOverride = withAvailableAgentModelOverride(
		registry,
		agent,
		selectionOverride,
		availableProviderModels
	);
	return {
		effective,
		selectionOverride: {
			...(availableSelectionOverride ?? {}),
			model: effective.model,
		},
	};
};

const resolveInitialSessionSelection = ({
	agent,
	initialMessage,
	model,
	registry,
	restoredConfig,
	selectionOverride,
	thinkingSelection,
	trustedProviderRegistrations,
	hostProviderRegistrations,
}: SessionSelectionInput): SessionSendInput => {
	const resolvedModel =
		normalizeProviderModelSelection(initialMessage.metadata?.model ?? model) ??
		model;
	const sessionModel = restoredConfig?.model ?? model;
	const sessionThinkingLevel =
		restoredConfig?.thinkingLevel ?? thinkingSelection.thinkingLevel;
	const sessionThinkingSelection: ThinkingSelection =
		sessionThinkingLevel === undefined
			? {}
			: { thinkingLevel: sessionThinkingLevel };
	const persistedThinkingLevel =
		restoredConfig?.thinkingLevel ?? initialMessage.metadata?.thinkingLevel;
	const persistedSelection: ThinkingSelection =
		persistedThinkingLevel === undefined
			? {}
			: { thinkingLevel: persistedThinkingLevel };
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
	const effective = resolveInteractiveAgentSelection(
		registry,
		persistedAgentId,
		persistedAgentIsAvailable ? resolvedModel : sessionModel,
		persistedAgentIsAvailable ? persistedSelection : sessionThinkingSelection,
		selectionOverride,
		trustedProviderRegistrations,
		sessionModel,
		persistedSubagentIsAvailable,
		hostProviderRegistrations
	);
	return {
		agent: effective.agent,
		sessionModel,
		sessionThinkingLevel: sessionThinkingSelection.thinkingLevel,
		model: effective.model,
		resolvedAgent: effective.resolvedAgent,
		selectionOverride: { ...selectionOverride, model: effective.model },
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
	const {
		agent,
		model,
		thinkingLevel,
		setAgent,
		setModel,
		setThinkingLevel,
		submissionSelectionOverride,
	} = usePromptConfig();
	const currentThinkingSelection = useMemo<ThinkingSelection>(
		() => (thinkingLevel === undefined ? {} : { thinkingLevel }),
		[thinkingLevel]
	);
	const registry = useAgentRegistry();
	const getTrustedProviderRegistrations = useCallback(
		() =>
			getInteractivePluginRuntime()?.getProviderRegistrations(sessionId) ?? [],
		[sessionId]
	);
	const getHostProviderRegistrations = useCallback(
		(providerId: string) => {
			const providerController = host.providerController;
			if (providerController?.getPluginProviderComposition === undefined) {
				return;
			}
			const registration =
				providerController.getPluginProviderComposition(
					providerId
				)?.registration;
			return registration === undefined ? [] : [registration];
		},
		[host]
	);
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
			...omitUndefined({
				model,
			}),
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
	const interruptResetTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const interruptArmedRef = useRef(false);
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
		cacheWarmingStatus,
		sessionUsageEntries,
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
			void recallIntoComposer(interrupt());
			return;
		}

		interruptArmedRef.current = true;

		clearTimeout(interruptResetTimeoutRef.current ?? 0);

		interruptResetTimeoutRef.current = setTimeout(() => {
			interruptArmedRef.current = false;
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
		return host.withSessionWork(
			async () => {
				try {
					host.assertCurrentPluginProviderRegistrationSnapshot();
					const effective = resolveInteractiveAgentSelection(
						registry,
						agent,
						model,
						currentThinkingSelection,
						submissionSelectionOverride,
						getTrustedProviderRegistrations(),
						restoredConfig?.model,
						false,
						getHostProviderRegistrations
					);
					if (
						effective.unavailableReason !== undefined &&
						host.providerController === undefined
					) {
						show({ message: effective.unavailableReason, variant: "error" });
						return false;
					}
					const thinkingSelection: ThinkingSelection =
						effective.thinkingLevel === undefined
							? {}
							: { thinkingLevel: effective.thinkingLevel };
					const compactWithProviderModel = async (
						selection: ProviderModelSelection,
						providerModel: ProviderModel
					): Promise<void> => {
						const normalizedThinking = normalizeProviderModelThinkingSelection(
							providerModel,
							thinkingSelection
						);
						await compact(focus, selection, normalizedThinking);
					};
					const availableModels =
						(await host.providerController?.getAvailableModels(
							effective.model.providerId
						)) ?? [];
					host.assertCurrentPluginProviderRegistrationSnapshot();
					const currentProviderModel = availableModels.find((providerModel) =>
						isSameProviderModelIdentity(providerModel, effective.model)
					);
					if (currentProviderModel !== undefined) {
						await compactWithProviderModel(
							effective.model,
							currentProviderModel
						);
						return true;
					}
					const providerController = host.providerController;
					if (providerController === undefined) {
						show({
							message: `Provider Model ${effective.model.providerId}/${effective.model.modelId} is unavailable. Choose a current model to compact this session.`,
							variant: "error",
						});
						return false;
					}
					dialog.open({
						children: (
							<ProviderModelsDialogContent
								controller={providerController}
								currentModel={effective.model}
								onSelectModel={async (providerModel, selection) => {
									host.assertCurrentPluginProviderRegistrationSnapshot();
									try {
										await compactWithProviderModel(selection, providerModel);
									} catch (error) {
										show({
											message: getErrorMessage(error, "Compaction failed."),
											variant: "error",
										});
									}
								}}
							/>
						),
						title: "Choose Model for Compaction",
					});
					return true;
				} catch (error) {
					show({
						message: getErrorMessage(error, "Compaction failed."),
						variant: "error",
					});
					return false;
				}
			},
			(reason) => {
				show({ message: reason, variant: "error" });
				return false;
			}
		);
	};

	const executeCompactionCommand = (focus?: string) =>
		runManualCompaction(focus);

	const submitWithinSessionWork = async (
		submission: ChatPromptSubmission,
		activeRegistry: AgentRegistry
	): Promise<boolean> => {
		const { composition, files, skill, text } = submission;
		const userText = text.trim();
		let effective: EffectiveAgentSelection;
		let selectionOverride: AgentSelectionOverride;
		try {
			const resolved = await resolveInteractiveSubmissionSelection({
				agent,
				fallbackModel: model,
				hostProviderRegistrations: getHostProviderRegistrations,
				assertProviderSnapshot:
					host.assertCurrentPluginProviderRegistrationSnapshot,
				providerController: host.providerController,
				registry: activeRegistry,
				restoredModel: restoredConfig?.model,
				selectionOverride: submissionSelectionOverride,
				thinkingSelection: currentThinkingSelection,
				trustedProviderRegistrations: getTrustedProviderRegistrations(),
			});
			effective = resolved.effective;
			selectionOverride = resolved.selectionOverride;
		} catch (error) {
			show({
				message: getErrorMessage(error, "Could not inspect Provider Models."),
				variant: "error",
			});
			return false;
		}
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
		try {
			const outcome = await prompt({
				agent: effective.agent,
				sessionModel: model,
				...(thinkingLevel === undefined
					? {}
					: { sessionThinkingLevel: thinkingLevel }),
				selectionOverride,
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
			});
			if (outcome.rejected) {
				show({ message: outcome.reason, variant: "error" });
				return false;
			}
			return true;
		} catch {
			show({ message: "Could not submit the prompt", variant: "error" });
			return false;
		} finally {
			if (optimisticMessage) {
				setOptimisticMessages((pending) =>
					pending.filter(({ id }) => id !== optimisticMessage.id)
				);
			}
		}
	};

	const submitMessage = async (submission: ChatPromptSubmission) => {
		const { files, skill, text } = submission;
		if (text.trim().length === 0 && files.length === 0 && isUndefined(skill)) {
			return false;
		}
		if (isNull(registry) || !isPromptConfigRestored) {
			return false;
		}
		return host.withSessionWork(
			() => submitWithinSessionWork(submission, registry),
			(reason) => {
				show({ message: reason, variant: "error" });
				return false;
			}
		);
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
		try {
			const outcome = await send({
				...resolveInitialSessionSelection({
					agent,
					initialMessage,
					model,
					registry,
					restoredConfig,
					selectionOverride: submissionSelectionOverride,
					thinkingSelection: currentThinkingSelection,
					trustedProviderRegistrations: getTrustedProviderRegistrations(),
					hostProviderRegistrations: getHostProviderRegistrations,
				}),
				messageId,
			});
			if (outcome.rejected) {
				show({ message: outcome.reason, variant: "error" });
			}
		} catch (error) {
			show({
				message: getErrorMessage(error, "Could not retry the Agent Turn."),
				variant: "error",
			});
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
						selectionOverride: submissionSelectionOverride,
						thinkingSelection: currentThinkingSelection,
						trustedProviderRegistrations: getTrustedProviderRegistrations(),
						hostProviderRegistrations: getHostProviderRegistrations,
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
		getTrustedProviderRegistrations,
		getHostProviderRegistrations,
		submissionSelectionOverride,
		send,
		sessionId,
		show,
		currentThinkingSelection,
	]);

	return (
		<box flexDirection="row" height="100%" width="100%">
			<box flexGrow={1} height="100%">
				<ChatShell
					activeMessages={activeMessages}
					cacheWarmingStatus={cacheWarmingStatus}
					compactions={snapshot.compactions}
					draftKey={sessionId}
					error={error}
					isBusy={isBusy}
					isCompacting={snapshot.isCompacting}
					isSelectionReady={isPromptConfigRestored}
					key={sessionId}
					messages={messages}
					onCompact={executeCompactionCommand}
					onEmptySubmit={steerQueuedHead}
					onOpenSettings={openSettings}
					onProviderModelChanged={host.cancelCacheWarming}
					onRetry={retryMessage}
					onSubmit={submitMessage}
					promptHistory={promptHistory}
					providerController={host.providerController}
					queuedSubmissions={snapshot.queuedSubmissions}
					recalledSubmissions={recalledSubmissions}
					recallRevision={recallRevision}
					sessionUsageEntries={sessionUsageEntries}
					transcriptNotice={<ProjectTrustNotice />}
					viewId={sessionId}
				/>
			</box>
		</box>
	);
}
