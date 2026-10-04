import { getErrorMessage } from "@wincode/utils";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import type { SessionHost } from "@/modules/sessions/host/types";
import { useSessionCapabilities } from "@/modules/sessions/host/use-session-capabilities";
import {
	type SessionMessage,
	sanitizeInterruptedSessionMessages,
} from "@/modules/sessions/message";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { projectSessionRecords } from "@/modules/sessions/storage/session-record";
import {
	SessionInUseError,
	type SessionWriterLockOwner,
} from "@/modules/sessions/storage/session-writer-lock";
import type { SessionId } from "@/shared/identifiers";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	SessionWriterAction,
	SessionWriterOwnerLabel,
} from "../components/session-writer-controls";
import type { SessionInitialSubmission } from "./session-view";
import { SessionView } from "./session-view";
import { StoredSessionHistoryView } from "./stored-session-history-view";

type OpenedSession = Readonly<{
	host: SessionHost;
	sessionTitle: string;
	transcript: readonly SessionMessage[];
}>;
type StoredSessionHistory = Readonly<{
	compactions: readonly SessionCompaction[];
	sessionTitle: string;
	transcript: readonly SessionMessage[];
}>;

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
			kind: "history";
			owner: SessionWriterLockOwner | undefined;
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
	return { compactions, sessionTitle: row.title, transcript };
};

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
	const capabilities = useSessionCapabilities();
	const [surface, setSurface] = useState<SessionSurfaceState>({
		kind: "opening",
	});
	const [backgroundApprovalNotice, setBackgroundApprovalNotice] = useState<{
		pendingApprovalCount: number;
		sessionId: SessionId;
	} | null>(null);
	const refreshHistoryRef = useRef<(() => void) | null>(null);
	const retryOpenRef = useRef<(() => void) | null>(null);
	const viewHistoryRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		const manager = capabilities.getSessionHostManager();
		return manager.onEvent((event) => {
			if (
				event.type !== "session-approval-notice" ||
				event.sessionId === sessionId
			) {
				return;
			}
			setBackgroundApprovalNotice(
				event.pendingApprovalCount === 0
					? (current) =>
							current?.sessionId === event.sessionId ? null : current
					: {
							pendingApprovalCount: event.pendingApprovalCount,
							sessionId: event.sessionId,
						}
			);
		});
	}, [capabilities, sessionId]);
	const handleRefreshHistory = useCallback(() => {
		refreshHistoryRef.current?.();
	}, []);
	const handleRetryOpen = useCallback(() => {
		retryOpenRef.current?.();
	}, []);
	const handleViewHistory = useCallback(() => {
		viewHistoryRef.current?.();
	}, []);

	useEffect(() => {
		let ignore = false;
		let opening = false;
		let historyActionInFlight = false;
		let contentionOwner: SessionWriterLockOwner | undefined;
		let viewAcquired = false;
		let releaseRequested = false;
		const manager = capabilities.getSessionHostManager();
		setSurface({ kind: "opening" });

		const releaseView = (): void => {
			releaseRequested = true;
			if (!viewAcquired) {
				return;
			}
			viewAcquired = false;
			void manager.releaseView(sessionId).catch(() => undefined);
		};
		const open = async (): Promise<OpenedSession | null> => {
			const host = await manager.openHost({
				capabilities,
				executionMode: "interactive",
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
					store.attachmentStore
						? store.attachmentStore.annotateMessagesForDisplay(
								host.getSnapshot().transcript
							)
						: host.getSnapshot().transcript,
				]);
				if (ignore) {
					return null;
				}
				return {
					host,
					sessionTitle: row.title,
					transcript,
				};
			} catch (error) {
				releaseView();
				throw error;
			}
		};

		const openWritableSession = async (fromHistory: boolean): Promise<void> => {
			if (ignore || opening) {
				return;
			}
			opening = true;
			if (fromHistory) {
				setSurface((current) =>
					current.kind === "history"
						? { ...current, isRetrying: true }
						: current
				);
			}
			try {
				const next = await open();
				if (next && !ignore) {
					setSurface({ kind: "opened", session: next });
				}
			} catch (error) {
				if (!ignore) {
					handleSessionOpenFailure(error, fromHistory, setSurface, (owner) => {
						contentionOwner = owner;
					});
				}
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
						kind: "history",
						owner: contentionOwner,
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
			void openWritableSession(true).finally(() => {
				historyActionInFlight = false;
			});
		};

		refreshHistoryRef.current = refreshHistory;
		retryOpenRef.current = retryOpen;
		viewHistoryRef.current = viewStoredHistory;
		void openWritableSession(false);

		return () => {
			ignore = true;
			refreshHistoryRef.current = null;
			retryOpenRef.current = null;
			viewHistoryRef.current = null;
			releaseView();
		};
	}, [capabilities, sessionId]);

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
				messages={surface.history.transcript}
				onRefresh={handleRefreshHistory}
				onRetry={handleRetryOpen}
				owner={surface.owner}
				sessionTitle={surface.history.sessionTitle}
			/>
		);
	}

	return (
		<box flexDirection="column" flexGrow={1} width="100%">
			{backgroundApprovalNotice && (
				<text fg={colors.warning}>
					Session {backgroundApprovalNotice.sessionId} has{" "}
					{backgroundApprovalNotice.pendingApprovalCount} pending approval
					{backgroundApprovalNotice.pendingApprovalCount === 1 ? "" : "s"}. Open
					that Session to review; its Agent is paused.
				</text>
			)}
			<SessionView
				host={surface.session.host}
				initialSubmission={initialSubmission}
				initialTranscript={surface.session.transcript}
				sessionId={sessionId}
				sessionTitle={surface.session.sessionTitle}
			/>
		</box>
	);
}
