import type { AgentId } from "@wincode/agent-core";
import type {
	ProviderCollection,
	ProviderModel,
	ThinkingSelection,
} from "@wincode/ai";
import { getErrorMessage } from "@wincode/utils";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentSelectionOverride,
	resolveActiveAgentId,
	resolveInteractiveAgentSelection,
	useAgentRegistry,
} from "@/modules/agents";
import type { AgentRegistry } from "@/modules/agents/registry";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import {
	arePluginProviderRegistrationsBoundToTrustedOwners,
	DEFAULT_PROVIDER_MODEL_SELECTION,
	type PluginProviderOwnerRegistration,
	type ProviderModelSelection,
	ProviderModelSelectionOwnershipError,
	UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE,
} from "@/modules/providers/provider-model-selection";
import { ProviderModelsDialogContent } from "@/modules/providers/ui/provider-models-dialog";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import { withSessionManagerWork } from "@/modules/sessions/host/session-host-manager";
import type {
	SessionCapabilities,
	SessionHost,
	SessionHostManager,
} from "@/modules/sessions/host/types";
import { useSessionServicesHandle } from "@/modules/sessions/host/use-session-services";
import {
	type SessionMessage,
	sanitizeInterruptedSessionMessages,
} from "@/modules/sessions/message";
import { getPluginProviderRegistrationsFromCollection } from "@/modules/sessions/provider-collection";
import {
	restorableSelectionModel,
	restoreSelection,
} from "@/modules/sessions/selection";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { projectSessionRecords } from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import {
	SessionInUseError,
	type SessionWriterLockOwner,
} from "@/modules/sessions/storage/session-writer-lock";
import type { SessionId } from "@/shared/identifiers";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getInteractivePluginRuntime } from "@/shared/runtime-context";
import {
	SessionWriterAction,
	SessionWriterOwnerLabel,
} from "../components/session-writer-controls";
import type { SessionInitialSubmission } from "./session-view";
import { SessionView } from "./session-view";
import { StoredSessionHistoryView } from "./stored-session-history-view";

type OpenedSession = Readonly<{
	host: SessionHost;
	initialSubmission?: SessionInitialSubmission;
	sessionTitle: string;
	transcript: readonly SessionMessage[];
}>;
type StoredSessionHistory = Readonly<{
	compactions: readonly SessionCompaction[];
	model: ProviderModelSelection | undefined;
	sessionTitle: string;
	transcript: readonly SessionMessage[];
}>;

type SessionProviderSelection = Readonly<{
	agentPinSelection?: ProviderModelSelection;
	providerModel?: ProviderModelSelection;
}>;

type AgentPinPreflight =
	| { kind: "pending" }
	| { kind: "ready"; selection: ProviderModelSelection | undefined }
	| { error: unknown; kind: "error" };

type SessionSurfaceState =
	| { kind: "opening" }
	| { kind: "opened"; session: OpenedSession }
	| {
			isViewingHistory: boolean;
			kind: "contention";
			owner: SessionWriterLockOwner | undefined;
	  }
	| {
			history: StoredSessionHistory;
			isRefreshing: boolean;
			isRetrying: boolean;
			isSelectingModel: boolean;
			kind: "history";
			owner: SessionWriterLockOwner | undefined;
			selectionError: string | undefined;
			selectionPickerError: string | undefined;
	  }
	| { kind: "failure"; message: string };
type SetSessionSurface = Dispatch<SetStateAction<SessionSurfaceState>>;

const handleSessionOpenFailure = (
	error: unknown,
	fromHistory: boolean,
	setSurface: SetSessionSurface,
	rememberOwner: (owner: SessionWriterLockOwner | undefined) => void
): void => {
	if (error instanceof SessionInUseError) {
		rememberOwner(error.owner);
		setSurface((current) => {
			if (fromHistory) {
				return current.kind === "history"
					? { ...current, isRetrying: false, owner: error.owner }
					: current;
			}
			return {
				isViewingHistory: false,
				kind: "contention",
				owner: error.owner,
			};
		});
		return;
	}
	setSurface({
		kind: "failure",
		message: getErrorMessage(error, "Could not load session."),
	});
};

const transcriptForDisplay = (
	host: SessionHost,
	store: SessionStore
): Promise<readonly SessionMessage[]> => {
	const transcript = host.getSnapshot().transcript;
	return (
		store.attachmentStore?.annotateMessagesForDisplay(transcript) ??
		Promise.resolve(transcript)
	);
};

const createProviderReselection = async (
	capabilities: SessionCapabilities,
	sessionId: SessionId
): Promise<
	Readonly<{
		controller: InteractiveProviderController;
		providerCollection: ProviderCollection;
	}>
> => {
	const pluginRuntime = capabilities.getPluginRuntime?.();
	const providerCollection = await capabilities.createProviderCollection?.(
		pluginRuntime,
		sessionId
	);
	if (providerCollection === undefined) {
		throw new Error("Provider Model selection is unavailable.");
	}
	const trustedRegistrations =
		pluginRuntime?.getProviderRegistrations(sessionId) ?? [];
	const collectionRegistrations =
		getPluginProviderRegistrationsFromCollection(providerCollection);
	if (
		!arePluginProviderRegistrationsBoundToTrustedOwners(
			trustedRegistrations,
			collectionRegistrations
		)
	) {
		await providerCollection.close().catch(() => undefined);
		throw new Error(UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE);
	}
	const getCompositionRevision = (): number => {
		if (
			"getCompositionRevision" in providerCollection &&
			typeof providerCollection.getCompositionRevision === "function"
		) {
			return providerCollection.getCompositionRevision();
		}
		return 0;
	};
	return {
		controller: createInteractiveProviderController(providerCollection, {
			getCompositionRevision,
			getPluginProviderRegistrations: () =>
				getPluginProviderRegistrationsFromCollection(providerCollection) ?? [],
			getTrustedPluginProviderRegistrations: () =>
				capabilities
					.getPluginRuntime?.()
					?.getProviderRegistrations(sessionId) ?? [],
			getTrustedPluginProviderRuntime: () => capabilities.getPluginRuntime?.(),
			withSessionWork: (action) =>
				withSessionManagerWork(capabilities.getSessionHostManager(), action),
		}),
		providerCollection,
	};
};

const loadStoredSessionHistory = async (
	sessionId: SessionId
): Promise<StoredSessionHistory> => {
	const store = getSessionStore();
	const [row, records, compactions] = await Promise.all([
		store.getSession(sessionId),
		store.listSessionRecords(sessionId),
		store.getCompactions(sessionId),
	]);
	const savedTranscript = sanitizeInterruptedSessionMessages(
		projectSessionRecords(records)
	);
	const transcript = store.attachmentStore
		? await store.attachmentStore.annotateMessagesForDisplay(savedTranscript)
		: savedTranscript;
	return {
		compactions,
		model: restoreSelection({ messages: savedTranscript, row })?.model,
		sessionTitle: row.title,
		transcript,
	};
};

const resolveCurrentAgentPin = async ({
	agent,
	model,
	registry,
	selectionOverride,
	sessionId,
	thinkingSelection,
	trustedRegistrations,
}: {
	readonly agent: AgentId;
	readonly model: ProviderModelSelection;
	readonly registry: AgentRegistry;
	readonly selectionOverride: AgentSelectionOverride;
	readonly sessionId: SessionId;
	readonly thinkingSelection: ThinkingSelection;
	readonly trustedRegistrations: readonly PluginProviderOwnerRegistration[];
}): Promise<ProviderModelSelection | undefined> => {
	const store = getSessionStore();
	const [row, records] = await Promise.all([
		store.getSession(sessionId),
		store.listSessionRecords(sessionId),
	]);
	const transcript = projectSessionRecords(records);
	const storedSelection = restoreSelection({
		messages: transcript,
		resolveAgent: (persistedAgent) =>
			resolveActiveAgentId(registry, persistedAgent),
		row,
		refs: {
			agent,
			model,
			...thinkingSelection,
		},
	});
	const effective = resolveInteractiveAgentSelection(
		registry,
		storedSelection?.agent ?? agent,
		storedSelection?.model ?? model,
		storedSelection?.thinkingLevel === undefined
			? thinkingSelection
			: { thinkingLevel: storedSelection.thinkingLevel },
		selectionOverride,
		trustedRegistrations,
		// Only a recorded tier is restored; a prompt-config ref is the caller's own choice.
		storedSelection?.source === "refs" ? undefined : storedSelection?.model
	);
	const selectedAgent = registry.agents.find(
		(candidate) => candidate.id === effective.agent
	);
	const currentModel = selectionOverride.model ?? selectedAgent?.model;
	return restorableSelectionModel(effective, currentModel);
};

function ProviderModelReselectionDialog({
	controller,
	currentModel,
	onDismiss,
	onSelectModel,
	providerCollection,
}: {
	readonly controller: InteractiveProviderController;
	readonly currentModel: ProviderModelSelection;
	readonly onDismiss: () => void;
	readonly onSelectModel: (
		model: ProviderModel,
		selection: ProviderModelSelection
	) => void | Promise<void>;
	readonly providerCollection: ProviderCollection;
}) {
	useEffect(
		() => () => {
			onDismiss();
			void providerCollection.close().catch(() => undefined);
		},
		[onDismiss, providerCollection]
	);
	return (
		<ProviderModelsDialogContent
			controller={controller}
			currentModel={currentModel}
			onSelectModel={onSelectModel}
		/>
	);
}

/**
 * Renders one Session view. The process-level Session Host manager owns loaded
 * runtimes; the surface holds a view reference and releases it on navigation.
 * The manager preserves active Sessions and unloads durable idle ones.
 */
export function SessionSurface({
	initialSubmission,
	sessionId,
}: {
	readonly initialSubmission?: SessionInitialSubmission;
	readonly sessionId: SessionId;
}) {
	const { colors } = useTheme();
	const sessionServicesHandle = useSessionServicesHandle();
	const registry = useAgentRegistry();
	const {
		agent,
		isAgentSelectionReady,
		model,
		submissionSelectionOverride,
		thinkingLevel,
	} = usePromptConfig();
	const pluginRuntime = getInteractivePluginRuntime();
	const thinkingSelection = useMemo<ThinkingSelection>(
		() => (thinkingLevel === undefined ? {} : { thinkingLevel }),
		[thinkingLevel]
	);
	const [agentPinPreflight, setAgentPinPreflight] = useState<AgentPinPreflight>(
		{ kind: "pending" }
	);
	const dialog = useDialog();
	// DialogProvider recreates its value when the stack changes; keep picker updates
	// from tearing down the Session Host effect.
	const dialogRef = useRef(dialog);
	dialogRef.current = dialog;
	const [surface, setSurface] = useState<SessionSurfaceState>({
		kind: "opening",
	});
	const initialSubmissionRef = useRef(initialSubmission);
	initialSubmissionRef.current = initialSubmission;
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const refreshHistoryRef = useRef<(() => void) | null>(null);
	const retryOpenRef = useRef<(() => void) | null>(null);
	const reselectModelRef = useRef<(() => void) | null>(null);
	const viewHistoryRef = useRef<(() => void) | null>(null);
	const selectionDialogOpenRef = useRef(false);
	const handleRefreshHistory = useCallback(() => {
		refreshHistoryRef.current?.();
	}, []);
	const handleRetryOpen = useCallback(() => {
		retryOpenRef.current?.();
	}, []);
	const handleViewHistory = useCallback(() => {
		viewHistoryRef.current?.();
	}, []);
	const handleReselectModel = useCallback(() => {
		reselectModelRef.current?.();
	}, []);
	const handleSelectionDialogDismiss = useCallback(() => {
		selectionDialogOpenRef.current = false;
		setSurface((current) =>
			current.kind === "history"
				? { ...current, isSelectingModel: false }
				: current
		);
	}, []);

	useEffect(() => {
		if (
			agentPinPreflight.kind !== "pending" ||
			!isAgentSelectionReady ||
			registry === null
		) {
			return;
		}
		let active = true;
		void resolveCurrentAgentPin({
			agent,
			model,
			registry,
			selectionOverride: submissionSelectionOverride,
			sessionId,
			thinkingSelection,
			trustedRegistrations:
				pluginRuntime?.getProviderRegistrations(sessionId) ?? [],
		})
			.then((selection) => {
				if (active) {
					setAgentPinPreflight({ kind: "ready", selection });
				}
			})
			.catch((error: unknown) => {
				if (active) {
					setAgentPinPreflight({ error, kind: "error" });
				}
			});
		return () => {
			active = false;
		};
	}, [
		agent,
		agentPinPreflight.kind,
		isAgentSelectionReady,
		model,
		pluginRuntime,
		registry,
		sessionId,
		submissionSelectionOverride,
		thinkingSelection,
	]);

	useEffect(() => {
		let ignore = false;
		let opening = false;
		let historyActionInFlight = false;
		let contentionOwner: SessionWriterLockOwner | undefined;
		let viewAcquired = false;
		let releaseRequested = false;
		let manager: SessionHostManager | undefined;
		setSurface({ kind: "opening" });

		const releaseView = (): void => {
			releaseRequested = true;
			if (!(viewAcquired && manager !== undefined)) {
				return;
			}
			viewAcquired = false;
			void manager.releaseView(sessionId).catch(() => undefined);
		};
		const open = async (
			providerSelection?: SessionProviderSelection
		): Promise<OpenedSession | null> => {
			const services = await sessionServicesHandle.open();
			if (ignore || releaseRequested) {
				return null;
			}
			const sessionHostManager = services.capabilities.getSessionHostManager();
			manager = sessionHostManager;
			const host = await sessionHostManager.openHost({
				capabilities: services.capabilities,
				executionMode: "interactive",
				...providerSelection,
				sessionId,
				view: true,
			});
			viewAcquired = true;
			if (ignore || releaseRequested) {
				releaseView();
				return null;
			}
			try {
				const store = getSessionStore();
				const [row, transcript] = await Promise.all([
					store.getSession(sessionId),
					transcriptForDisplay(host, store),
				]);
				if (ignore) {
					return null;
				}
				return {
					host,
					...(providerSelection?.providerModel === undefined
						? { initialSubmission: initialSubmissionRef.current }
						: {}),
					sessionTitle: row.title,
					transcript,
				};
			} catch (error) {
				releaseView();
				throw error;
			}
		};

		const showSelectionHistory = async (
			error: ProviderModelSelectionOwnershipError
		): Promise<void> => {
			try {
				const history = await loadStoredSessionHistory(sessionId);
				if (!ignore) {
					setSurface({
						history,
						isRefreshing: false,
						isRetrying: false,
						isSelectingModel: false,
						kind: "history",
						owner: undefined,
						selectionError: error.message,
						selectionPickerError: undefined,
					});
				}
			} catch (historyError) {
				if (!ignore) {
					setSurface({
						kind: "failure",
						message: getErrorMessage(
							historyError,
							"Could not load the read-only Session history."
						),
					});
				}
			}
		};

		const handleOpenFailure = async (
			error: unknown,
			fromHistory: boolean
		): Promise<void> => {
			if (ignore) {
				return;
			}
			if (error instanceof ProviderModelSelectionOwnershipError) {
				await showSelectionHistory(error);
				return;
			}
			handleSessionOpenFailure(error, fromHistory, setSurface, (owner) => {
				contentionOwner = owner;
			});
		};

		const openWritableSession = async (
			fromHistory: boolean,
			providerSelection?: SessionProviderSelection
		): Promise<void> => {
			if (ignore || opening) {
				return;
			}
			opening = true;
			if (fromHistory) {
				setSurface((current) =>
					current.kind === "history"
						? {
								...current,
								isRetrying: true,
								isSelectingModel: false,
								...(providerSelection?.providerModel === undefined
									? {}
									: {
											selectionError: undefined,
											selectionPickerError: undefined,
										}),
							}
						: current
				);
			}
			try {
				const next = await open(providerSelection);
				if (next && !ignore) {
					setSurface({ kind: "opened", session: next });
				}
			} catch (error) {
				opening = false;
				await handleOpenFailure(error, fromHistory);
			} finally {
				opening = false;
			}
		};

		const runHistoryAction = (
			onStart: () => void,
			onSuccess: (history: StoredSessionHistory) => void
		): void => {
			if (ignore || historyActionInFlight) {
				return;
			}
			historyActionInFlight = true;
			onStart();
			void (async () => {
				try {
					const history = await loadStoredSessionHistory(sessionId);
					if (!ignore) {
						onSuccess(history);
					}
				} catch (error) {
					if (!ignore) {
						setSurface({
							kind: "failure",
							message: getErrorMessage(error, "Could not load session."),
						});
					}
				} finally {
					historyActionInFlight = false;
				}
			})();
		};
		const viewStoredHistory = (): void => {
			runHistoryAction(
				() =>
					setSurface((current) =>
						current.kind === "contention"
							? { ...current, isViewingHistory: true }
							: current
					),
				(history) =>
					setSurface({
						history,
						isRefreshing: false,
						isRetrying: false,
						isSelectingModel: false,
						kind: "history",
						owner: contentionOwner,
						selectionError: undefined,
						selectionPickerError: undefined,
					})
			);
		};
		const refreshHistory = (): void => {
			runHistoryAction(
				() =>
					setSurface((current) =>
						current.kind === "history"
							? { ...current, isRefreshing: true }
							: current
					),
				(history) =>
					setSurface((current) =>
						current.kind === "history"
							? { ...current, history, isRefreshing: false }
							: current
					)
			);
		};

		const retryOpen = (): void => {
			if (ignore || historyActionInFlight) {
				return;
			}
			historyActionInFlight = true;
			void openWritableSession(
				true,
				agentPinPreflight.kind === "ready" &&
					agentPinPreflight.selection !== undefined
					? { agentPinSelection: agentPinPreflight.selection }
					: undefined
			).finally(() => {
				historyActionInFlight = false;
			});
		};
		const updatePickerError = (error: unknown): void => {
			selectionDialogOpenRef.current = false;
			const message = getErrorMessage(
				error,
				"Provider Model selection is unavailable."
			);
			setSurface((current) =>
				current.kind === "history"
					? {
							...current,
							isSelectingModel: false,
							selectionPickerError: message,
						}
					: current
			);
		};
		const openReselectionDialog = async (): Promise<void> => {
			const services = await sessionServicesHandle.open();
			if (ignore) {
				selectionDialogOpenRef.current = false;
				return;
			}
			const picker = await createProviderReselection(
				services.capabilities,
				sessionId
			);
			if (ignore) {
				selectionDialogOpenRef.current = false;
				await picker.providerCollection.close().catch(() => undefined);
				return;
			}
			const currentSelection =
				surfaceRef.current.kind === "history"
					? surfaceRef.current.history.model
					: undefined;
			const onSelectModel = async (
				_model: ProviderModel,
				selection: ProviderModelSelection
			): Promise<void> => {
				await openWritableSession(true, { providerModel: selection });
			};
			dialogRef.current.open({
				children: (
					<ProviderModelReselectionDialog
						controller={picker.controller}
						currentModel={currentSelection ?? DEFAULT_PROVIDER_MODEL_SELECTION}
						onDismiss={handleSelectionDialogDismiss}
						onSelectModel={onSelectModel}
						providerCollection={picker.providerCollection}
					/>
				),
				title: "Reselect Provider Model",
			});
		};
		const reselectModel = (): void => {
			if (
				ignore ||
				opening ||
				historyActionInFlight ||
				selectionDialogOpenRef.current
			) {
				return;
			}
			selectionDialogOpenRef.current = true;
			setSurface((current) =>
				current.kind === "history"
					? {
							...current,
							isSelectingModel: true,
							selectionPickerError: undefined,
						}
					: current
			);
			void openReselectionDialog().catch(updatePickerError);
		};

		refreshHistoryRef.current = refreshHistory;
		retryOpenRef.current = retryOpen;
		reselectModelRef.current = reselectModel;
		viewHistoryRef.current = viewStoredHistory;
		if (agentPinPreflight.kind === "ready") {
			void openWritableSession(
				false,
				agentPinPreflight.selection === undefined
					? undefined
					: { agentPinSelection: agentPinPreflight.selection }
			);
		} else if (agentPinPreflight.kind === "error") {
			void handleOpenFailure(agentPinPreflight.error, false);
		}

		return () => {
			ignore = true;
			refreshHistoryRef.current = null;
			retryOpenRef.current = null;
			reselectModelRef.current = null;
			viewHistoryRef.current = null;
			selectionDialogOpenRef.current = false;
			releaseView();
			// These services borrowed this view's providers; closing them releases
			// only a Plugin runtime they had to create for themselves.
			void sessionServicesHandle.close();
		};
	}, [
		agentPinPreflight,
		handleSelectionDialogDismiss,
		sessionServicesHandle,
		sessionId,
	]);

	if (surface.kind === "failure") {
		return <text fg={colors.error}>{surface.message}</text>;
	}

	if (surface.kind === "opening") {
		return <text fg={colors.text}>Loading session...</text>;
	}

	if (surface.kind === "contention") {
		return (
			<box flexDirection="column" flexGrow={1} gap={1} padding={1} width="100%">
				<text fg={colors.text}>
					Another Session Host holds this Session ID.
				</text>
				<text fg={colors.textMuted}>
					You can inspect committed history without opening another Agent
					Session.
				</text>
				<SessionWriterOwnerLabel owner={surface.owner} />
				<SessionWriterAction
					disabled={surface.isViewingHistory}
					id="session-contention-view-history"
					label={
						surface.isViewingHistory
							? "Loading Stored Session History..."
							: "View Stored Session History"
					}
					onActivate={handleViewHistory}
				/>
			</box>
		);
	}

	if (surface.kind === "history") {
		return (
			<StoredSessionHistoryView
				compactions={surface.history.compactions}
				isRefreshing={surface.isRefreshing}
				isRetrying={surface.isRetrying}
				isSelectingModel={surface.isSelectingModel}
				messages={surface.history.transcript}
				onRefresh={handleRefreshHistory}
				onReselectModel={handleReselectModel}
				onRetry={handleRetryOpen}
				owner={surface.owner}
				selectionError={surface.selectionError}
				selectionPickerError={surface.selectionPickerError}
				sessionTitle={surface.history.sessionTitle}
			/>
		);
	}

	return (
		<box flexDirection="column" flexGrow={1} width="100%">
			<SessionView
				host={surface.session.host}
				initialSubmission={surface.session.initialSubmission}
				initialTranscript={surface.session.transcript}
				sessionId={sessionId}
				sessionTitle={surface.session.sessionTitle}
			/>
		</box>
	);
}
