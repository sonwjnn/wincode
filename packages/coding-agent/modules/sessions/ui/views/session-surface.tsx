import { getErrorMessage } from "@wincode/runtime-utils";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import { createSessionHost } from "@/modules/sessions/host/session-host";
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

const pendingSurfaceClosures = new Map<SessionId, Promise<void>>();

const waitForPendingSurfaceClosure = async (
	sessionId: SessionId
): Promise<void> => {
	const pending = pendingSurfaceClosures.get(sessionId);
	if (pending !== undefined) {
		await pending;
	}
};

const trackSurfaceClosure = (
	sessionId: SessionId,
	closing: Promise<void>
): void => {
	const observed = closing.catch(() => undefined);
	pendingSurfaceClosures.set(sessionId, observed);
	void observed.then(() => {
		if (pendingSurfaceClosures.get(sessionId) === observed) {
			pendingSurfaceClosures.delete(sessionId);
		}
	});
};

/**
 * Opens a session and renders it. This surface owns the asynchronous
 * boundary: it constructs the Session Host and shows the opening state until
 * the session exists, then offers read-only Stored Session History only when a
 * Session Writer conflict prevents opening. Other failures remain errors; an
 * Agent Session does not exist until opening completes.
 *
 * It owns the session's presentation-only facts as well: the title read from the
 * session row, and the display-only annotation of the Transcript, which marks
 * attachment parts whose content is gone. Annotation never reaches the Session
 * Context, which the Host derives from the un-annotated projection.
 *
 * The consumer that constructs a Host owns calling `shutdown`, so this surface
 * shuts the session down when it unmounts or when the session it shows changes.
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
	const refreshHistoryRef = useRef<(() => void) | null>(null);
	const retryOpenRef = useRef<(() => void) | null>(null);
	const viewHistoryRef = useRef<(() => void) | null>(null);
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
		let openedHost: SessionHost | null = null;
		let openingHost: Promise<SessionHost> | null = null;
		setSurface({ kind: "opening" });

		const open = async (): Promise<OpenedSession | null> => {
			const pendingOpen = (async (): Promise<SessionHost> => {
				await waitForPendingSurfaceClosure(sessionId);
				return createSessionHost({
					capabilities,
					executionMode: "interactive",
					sessionId,
				});
			})();
			openingHost = pendingOpen;
			const host = await pendingOpen;
			if (ignore) {
				await host.shutdown();
				return null;
			}
			openedHost = host;
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
				openedHost = null;
				if (!ignore) {
					await host.shutdown();
				}
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
			const closingHost = openedHost;
			let closing: Promise<void> | undefined;
			try {
				closing =
					closingHost?.shutdown() ??
					openingHost?.then((host) => host.shutdown());
			} catch {
				closing = Promise.resolve();
			}
			if (closing !== undefined) {
				trackSurfaceClosure(sessionId, closing);
			}
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
		<SessionView
			host={surface.session.host}
			initialSubmission={initialSubmission}
			initialTranscript={surface.session.transcript}
			sessionId={sessionId}
			sessionTitle={surface.session.sessionTitle}
		/>
	);
}
