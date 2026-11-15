import * as fs from "node:fs/promises";
import type { SessionRecord } from "@wincode/agent-core";
import { isCode } from "@wincode/utils";
import type { EditMode } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import type { SessionCompaction } from "../compaction/types";
import type { Session } from "../session-pagination-types";
import type { SessionCatalogIssue, SessionUsageEntry } from "./session-catalog";
import {
	isSessionHistoryEntryEventType,
	type SessionJsonlProjection,
	SessionLogError,
	type SessionLogState,
	type SessionProjectionCursor,
	sessionProjectionBlocked,
	sessionProjectionCursorsEqual,
	sessionProjectionMatchesState,
} from "./session-jsonl-codec";
import { equalBytes, type SessionLog } from "./session-log";
import { SessionPaginationError } from "./session-pagination";

/**
 * A read point is the durable marker a cursor promises to keep reading. Modes
 * are named by the facet signature: a method that accepts a cursor reads at a
 * read point, everything else reads at head. A read point never catches up.
 */
type ProjectionReadPoint = Readonly<{
	catalogRevision?: number;
	generation: number;
	logId?: string;
	projectionId: string;
	readPointSequence?: number;
	sessionId?: SessionId;
}>;

type LogReadPoint = Readonly<{
	logId: string;
	readPointSequence: number;
	sessionId: SessionId;
}>;

export type ProjectedSessionReadPoint = ProjectionReadPoint | LogReadPoint;

const isProjectionReadPoint = (
	readPoint: ProjectedSessionReadPoint
): readPoint is ProjectionReadPoint =>
	"generation" in readPoint && "projectionId" in readPoint;

export type ProjectedSessionRead = Readonly<{
	getCompactions: () => Promise<SessionCompaction[]>;
	getEditMode: () => Promise<EditMode>;
	getLatestCompaction: () => Promise<SessionCompaction | null>;
	getSession: () => Promise<Session>;
	/** Projection generation this read is bound to. */
	generation: number;
	listSessionRecords: () => Promise<SessionRecord[]>;
	listSessionUsageEntries: () => Promise<SessionUsageEntry[]>;
	/** Runs the projection read under the mode that produced this view. */
	read: <Result>(operation: () => Promise<Result> | Result) => Promise<Result>;
	sessionId: SessionId;
}>;

export type ProjectedSessionStateRead = ProjectedSessionRead &
	Readonly<{
		state: SessionLogState;
	}>;

/**
 * The only way to read a projection. A handle binds one Session and the
 * projection generation it was opened against; it holds no file descriptor and
 * has no close. `atHead()` catches the projection up to the authoritative log
 * and re-binds the generation after catch-up, while `at(readPoint)`
 * deliberately does not catch up, re-checks the captured point immediately
 * before the read, and fails with `cursor_expired` once it no longer exists.
 */
export type ProjectedSession = Readonly<{
	assertAtHead: (
		cursor: SessionProjectionCursor | undefined,
		state: SessionLogState
	) => void;
	assertCursorWithinLog: (
		cursor: SessionProjectionCursor | undefined,
		state: SessionLogState
	) => void;
	at: (readPoint: ProjectedSessionReadPoint) => Promise<ProjectedSessionRead>;
	atHead: () => Promise<ProjectedSessionRead>;
	atHeadState: () => Promise<ProjectedSessionStateRead>;
	generation: number;
	sessionId: SessionId;
}>;

export type ProjectedSessionDependencies = Readonly<{
	assertNoUnresolvedOwnedSessionCreations: (root: string) => Promise<void>;
	checkDeletedMarker: (sessionId: SessionId) => Promise<void>;
	hasPendingAttachmentRecovery: (sessionId: SessionId) => boolean;
	log: SessionLog;
	projection: Pick<
		SessionJsonlProjection,
		| "getCursor"
		| "getMaintenanceState"
		| "isBoundToAnotherWorkspace"
		| "isBoundToWorkspace"
		| "listBoundSessionIds"
		| "projectEntries"
		| "workspaceId"
	>;
	projectionStore: Readonly<{
		getCompactions: (sessionId: SessionId) => Promise<SessionCompaction[]>;
		getEditMode: (sessionId: SessionId) => Promise<EditMode>;
		getLatestCompaction: (
			sessionId: SessionId
		) => Promise<SessionCompaction | null>;
		getSession: (sessionId: SessionId) => Promise<Session>;
		listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
		listSessionUsageEntries: (
			sessionId: SessionId
		) => Promise<SessionUsageEntry[]>;
	}>;
	reconcileDeletedSessionIfNeeded: (sessionId: SessionId) => Promise<void>;
	reconcileDeletedSessions: () => Promise<readonly SessionCatalogIssue[]>;
	reconcileSidecars: (
		sessionId: SessionId,
		logPath: string,
		bytes: Uint8Array,
		state: SessionLogState
	) => Promise<void>;
}>;

/**
 * Opens handles and performs the catalog-wide catch-ups that are not scoped to
 * one Session. Nothing outside this module decides when a projection must be
 * refreshed.
 */
export type ProjectedSessionStore = Readonly<{
	assertCatalogReadPoint: (readPoint: ProjectionReadPoint) => void;
	catchUpBoundCatalog: () => Promise<void>;
	catchUpRecentModelSelections: (
		sessionIds: readonly SessionId[]
	) => Promise<void>;
	open: (sessionId: SessionId) => Promise<ProjectedSession>;
	reconcileDeleted: () => Promise<void>;
}>;

export const createProjectedSessionStore = (
	ports: ProjectedSessionDependencies
): ProjectedSessionStore => {
	const { log, projection, projectionStore } = ports;

	const assertProjectionReady = (sessionId: SessionId): number => {
		const maintenance = projection.getMaintenanceState();
		if (maintenance.status !== "ready") {
			throw new SessionLogError(
				"session_projection_blocked",
				sessionId,
				"Session projection rebuild is incomplete; retry `wincode sessions rebuild` before opening Sessions."
			);
		}
		return maintenance.generation;
	};

	const assertCursorDoesNotExceedLog = (
		sessionId: SessionId,
		cursor: SessionProjectionCursor | undefined,
		state: SessionLogState
	): void => {
		if (cursor === undefined) {
			return;
		}
		const projectedEntry = state.entries[cursor.nextSequence - 1];
		if (
			cursor.logId !== state.logId ||
			cursor.nextSequence > state.nextSequence ||
			projectedEntry === undefined ||
			projectedEntry.endOffset !== cursor.nextByteOffset ||
			projectedEntry.envelope.entryHash !== cursor.lastHash
		) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				"SQLite projection cursor does not match the committed Session log.",
				{
					offset: cursor.nextByteOffset,
					sequence: cursor.nextSequence - 1,
				}
			);
		}
	};

	const projectionSessionIsMissing = async (
		sessionId: SessionId
	): Promise<boolean> => {
		try {
			await projectionStore.getSession(sessionId);
			return false;
		} catch (error) {
			if (error instanceof Error && error.message === "Session not found") {
				return true;
			}
			throw error;
		}
	};

	const catchUpProjection = (
		sessionId: SessionId,
		state: SessionLogState,
		cursor: SessionProjectionCursor | undefined,
		missingSession: boolean
	): SessionProjectionCursor | undefined => {
		let expectedCursor = cursor;
		for (;;) {
			const generation = projection.getMaintenanceState().generation;
			const replace =
				missingSession ||
				expectedCursor === undefined ||
				expectedCursor.generation !== generation;
			const projectedSequence = expectedCursor?.nextSequence ?? 0;
			const pending = replace
				? state.entries
				: state.entries.filter(
						({ envelope }) => envelope.sequence >= projectedSequence
					);
			try {
				projection.projectEntries(
					sessionId,
					pending,
					state,
					expectedCursor,
					replace ? "replace" : "append"
				);
			} catch {
				const latestCursor = projection.getCursor(sessionId);
				if (sessionProjectionCursorsEqual(latestCursor, expectedCursor)) {
					throw new SessionLogError(
						"session_projection_blocked",
						sessionId,
						"SQLite projection could not be rebuilt from the committed Session log."
					);
				}
				assertCursorDoesNotExceedLog(sessionId, latestCursor, state);
				expectedCursor = latestCursor;
			}
			const latestCursor = projection.getCursor(sessionId);
			assertCursorDoesNotExceedLog(sessionId, latestCursor, state);
			if (
				sessionProjectionMatchesState(
					latestCursor,
					state,
					projection.getMaintenanceState().generation
				)
			) {
				return latestCursor;
			}
			expectedCursor = latestCursor;
		}
	};

	const assertProjectionAtLogHead = (
		sessionId: SessionId,
		cursor: SessionProjectionCursor | undefined,
		state: SessionLogState
	): void => {
		if (
			!sessionProjectionMatchesState(
				cursor,
				state,
				projection.getMaintenanceState().generation
			)
		) {
			throw new SessionLogError(
				"session_projection_blocked",
				sessionId,
				"SQLite projection did not reach the committed Session log head."
			);
		}
	};

	const logChangedSinceProjectionRead = async (
		logPath: string,
		capturedBytes: Uint8Array | undefined
	): Promise<boolean> => {
		if (capturedBytes === undefined) {
			return false;
		}
		try {
			return !equalBytes(capturedBytes, await Bun.file(logPath).bytes());
		} catch {
			return false;
		}
	};

	const shouldRetryProjectionRead = async (
		error: unknown,
		logPath: string,
		capturedBytes: Uint8Array | undefined
	): Promise<boolean> =>
		error instanceof SessionLogError &&
		(error.code === "session_log_corrupt" ||
			error.code === "session_projection_blocked") &&
		projection.getMaintenanceState().status === "ready" &&
		(await logChangedSinceProjectionRead(logPath, capturedBytes));

	const assertProjectionSessionBound = async (
		sessionId: SessionId,
		logPath: string
	): Promise<void> => {
		if (projection.isBoundToWorkspace(sessionId)) {
			return;
		}
		if (!projection.isBoundToAnotherWorkspace(sessionId)) {
			await fs.stat(logPath);
		}
		throw new Error("Session not found");
	};

	const ensureProjected = async (
		sessionId: SessionId
	): Promise<SessionLogState> => {
		const generation = assertProjectionReady(sessionId);
		const logPath = await log.logPath(sessionId);
		await assertProjectionSessionBound(sessionId, logPath);
		await ports.checkDeletedMarker(sessionId);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			let capturedBytes: Uint8Array | undefined;
			try {
				const snapshot = await log.readWithRetry(sessionId);
				capturedBytes = snapshot.bytes;
				const { state } = snapshot;
				await log.syncPrefix(logPath, capturedBytes, sessionId);
				await ports.reconcileSidecars(sessionId, logPath, capturedBytes, state);
				let cursor = projection.getCursor(sessionId);
				assertCursorDoesNotExceedLog(sessionId, cursor, state);
				const missingSession = await projectionSessionIsMissing(sessionId);
				if (
					missingSession ||
					cursor === undefined ||
					cursor.generation !== generation ||
					cursor.nextSequence < state.nextSequence
				) {
					cursor = catchUpProjection(sessionId, state, cursor, missingSession);
				}
				assertProjectionAtLogHead(sessionId, cursor, state);
				return state;
			} catch (error) {
				if (!(await shouldRetryProjectionRead(error, logPath, capturedBytes))) {
					throw error;
				}
			}
		}
		throw new SessionLogError(
			"session_projection_blocked",
			sessionId,
			"Session log kept changing while its projection was being refreshed."
		);
	};

	const hasPendingProjectionRecovery = async (
		sessionId: SessionId
	): Promise<boolean> =>
		ports.hasPendingAttachmentRecovery(sessionId) ||
		(await log.readWriteIntent(sessionId)) !== undefined;

	const isProjectionCursorReady = async (
		sessionId: SessionId,
		generation: number,
		cursor: SessionProjectionCursor | undefined
	): Promise<boolean> =>
		cursor !== undefined &&
		cursor.generation === generation &&
		cursor.nextSequence >= 2 &&
		!(await projectionSessionIsMissing(sessionId));

	const projectionLogSize = async (
		logPath: string
	): Promise<number | undefined> => {
		try {
			return (await fs.stat(logPath)).size;
		} catch {
			return;
		}
	};

	const tryReadProjectionSuffix = async (
		sessionId: SessionId,
		cursor: SessionProjectionCursor
	): Promise<
		Readonly<{ bytes: Uint8Array; state: SessionLogState }> | undefined
	> => {
		try {
			return await log.readSuffix(sessionId, cursor);
		} catch {
			return;
		}
	};

	// A suffix lacks earlier graph identities, so history writes need full-log
	// validation before their records can become visible through the projection.
	const suffixNeedsFullProjectionReplay = (state: SessionLogState): boolean =>
		state.entries.length === 0 ||
		state.entries.some(
			({ envelope }) =>
				isSessionHistoryEntryEventType(envelope.type) ||
				["session.created", "session.deleted", "session.forked"].includes(
					envelope.type
				)
		);

	const projectProjectionSuffix = (
		sessionId: SessionId,
		cursor: SessionProjectionCursor,
		state: SessionLogState
	): boolean => {
		try {
			projection.projectEntries(
				sessionId,
				state.entries,
				state,
				cursor,
				"append"
			);
			assertProjectionAtLogHead(
				sessionId,
				projection.getCursor(sessionId),
				state
			);
			return true;
		} catch {
			return false;
		}
	};

	const ensureProjectionCaughtUp = async (
		sessionId: SessionId
	): Promise<void> => {
		const generation = assertProjectionReady(sessionId);
		const logPath = await log.logPath(sessionId);
		await ports.reconcileDeletedSessionIfNeeded(sessionId);
		await assertProjectionSessionBound(sessionId, logPath);
		await ports.checkDeletedMarker(sessionId);
		if (await hasPendingProjectionRecovery(sessionId)) {
			await ensureProjected(sessionId);
			return;
		}
		const cursor = projection.getCursor(sessionId);
		if (
			cursor === undefined ||
			!(await isProjectionCursorReady(sessionId, generation, cursor))
		) {
			await ensureProjected(sessionId);
			return;
		}
		const logSize = await projectionLogSize(logPath);
		if (logSize === cursor.nextByteOffset) {
			return;
		}
		if (logSize === undefined || logSize < cursor.nextByteOffset) {
			await ensureProjected(sessionId);
			return;
		}
		const suffix = await tryReadProjectionSuffix(sessionId, cursor);
		if (suffix === undefined || suffixNeedsFullProjectionReplay(suffix.state)) {
			await ensureProjected(sessionId);
			return;
		}
		if (!projectProjectionSuffix(sessionId, cursor, suffix.state)) {
			await ensureProjected(sessionId);
		}
	};

	const ensureCatalogSessionProjected = async (
		sessionId: SessionId
	): Promise<void> => {
		try {
			await ensureProjectionCaughtUp(sessionId);
		} catch (error) {
			if (isCode(error, "session_deleted")) {
				return;
			}
			if (isCode(error, "ENOENT")) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"A bound Session is missing its authoritative JSONL log.",
					{ cause: error }
				);
			}
			throw error;
		}
	};

	const ensureBoundCatalogLogsProjected = async (): Promise<void> => {
		await log.ensureRootDurable();
		const root = await log.canonicalRoot();
		await ports.assertNoUnresolvedOwnedSessionCreations(root);
		const generation = projection.getMaintenanceState().generation;
		for (const sessionId of projection.listBoundSessionIds()) {
			const logPath = await log.logPath(sessionId);
			const cursor = projection.getCursor(sessionId);
			let size: number;
			try {
				({ size } = await fs.stat(logPath));
			} catch (error) {
				if (!isCode(error, "ENOENT")) {
					throw error;
				}
				await ensureCatalogSessionProjected(sessionId);
				continue;
			}
			if (
				cursor === undefined ||
				cursor.generation !== generation ||
				cursor.nextByteOffset !== size
			) {
				await ensureCatalogSessionProjected(sessionId);
			}
		}
	};

	const ensureRecentModelSelectionsProjected = async (
		sessionIds: readonly SessionId[]
	): Promise<void> => {
		for (const sessionId of sessionIds) {
			await ports.reconcileDeletedSessionIfNeeded(sessionId);
			await ensureProjected(sessionId);
		}
	};

	const ensureDeletedSessionsReconciled = async (): Promise<void> => {
		const issues = await ports.reconcileDeletedSessions();
		const firstIssue = issues[0];
		if (firstIssue !== undefined) {
			throw Object.assign(new Error(firstIssue.message), {
				code: firstIssue.code,
				sessionId: firstIssue.sessionId,
			});
		}
	};

	const assertReadPoint = (
		sessionId: SessionId,
		readPoint: ProjectedSessionReadPoint
	): void => {
		if (
			readPoint.sessionId !== undefined &&
			readPoint.sessionId !== sessionId
		) {
			throw new SessionPaginationError(
				"cursor_invalid",
				"Session read point belongs to a different Session."
			);
		}
		// A projection-backed read point names the generation it was minted
		// under; a log-backed one (the history tree) is validated against the
		// authoritative log by the tree snapshot resolver instead.
		if (!isProjectionReadPoint(readPoint)) {
			return;
		}
		const generation = assertProjectionReady(sessionId);
		const maintenance = projection.getMaintenanceState();
		if (readPoint.projectionId !== maintenance.projectionId) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session read point expired after the projection was reset."
			);
		}
		if (readPoint.generation !== generation) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session read point expired after projection maintenance."
			);
		}
		if (readPoint.logId !== undefined) {
			const cursor = projection.getCursor(sessionId);
			if (cursor === undefined || cursor.logId !== readPoint.logId) {
				throw new SessionPaginationError(
					"cursor_expired",
					"Session read point no longer matches its captured log prefix."
				);
			}
			if (
				readPoint.readPointSequence !== undefined &&
				readPoint.readPointSequence > cursor.nextSequence - 1
			) {
				throw new SessionPaginationError(
					"cursor_invalid",
					"Session read point refers to a future projection prefix."
				);
			}
		}
	};

	const assertCatalogReadPoint = (readPoint: ProjectionReadPoint): void => {
		const maintenance = projection.getMaintenanceState();
		if (maintenance.status !== "ready") {
			throw sessionProjectionBlocked(
				"Session projection rebuild is incomplete; retry `wincode sessions rebuild` before reading Session pages."
			);
		}
		if (
			readPoint.projectionId !== undefined &&
			readPoint.projectionId !== maintenance.projectionId
		) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session catalog cursor expired after the projection was reset."
			);
		}
		if (
			readPoint.generation !== undefined &&
			readPoint.generation !== maintenance.generation
		) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session catalog cursor expired after projection maintenance."
			);
		}
		if (
			readPoint.catalogRevision !== undefined &&
			readPoint.catalogRevision > maintenance.catalogRevision
		) {
			throw new SessionPaginationError(
				"cursor_invalid",
				"Session catalog cursor refers to a future catalog revision."
			);
		}
	};

	const assertCurrentGeneration = (
		sessionId: SessionId,
		generation: number
	): void => {
		if (projection.getMaintenanceState().generation !== generation) {
			throw new SessionLogError(
				"session_projection_blocked",
				sessionId,
				"Session projection changed while the read was in progress; retry after projection maintenance."
			);
		}
	};

	const createReadView = (
		targetSessionId: SessionId,
		generation: number,
		check: () => void
	): ProjectedSessionRead => {
		const view: ProjectedSessionRead = {
			generation,
			sessionId: targetSessionId,
			read: async (operation) => {
				check();
				return await operation();
			},
			getCompactions: async () =>
				await view.read(() => projectionStore.getCompactions(targetSessionId)),
			getEditMode: async () =>
				await view.read(() => projectionStore.getEditMode(targetSessionId)),
			getLatestCompaction: async () =>
				await view.read(() =>
					projectionStore.getLatestCompaction(targetSessionId)
				),
			getSession: async () =>
				await view.read(() => projectionStore.getSession(targetSessionId)),
			listSessionRecords: async () =>
				await view.read(() =>
					projectionStore.listSessionRecords(targetSessionId)
				),
			listSessionUsageEntries: async () =>
				await view.read(() =>
					projectionStore.listSessionUsageEntries(targetSessionId)
				),
		};
		return view;
	};

	const open = async (sessionId: SessionId): Promise<ProjectedSession> => {
		const generation = assertProjectionReady(sessionId);
		return {
			generation,
			sessionId,
			at: async (readPoint) => {
				assertReadPoint(sessionId, readPoint);
				return createReadView(
					sessionId,
					isProjectionReadPoint(readPoint) ? readPoint.generation : generation,
					() => assertReadPoint(sessionId, readPoint)
				);
			},
			atHead: async () => {
				await ports.reconcileDeletedSessionIfNeeded(sessionId);
				if (!projection.isBoundToWorkspace(sessionId)) {
					throw new Error("Session not found");
				}
				await ensureProjectionCaughtUp(sessionId);
				const current = assertProjectionReady(sessionId);
				return createReadView(sessionId, current, () =>
					assertCurrentGeneration(sessionId, current)
				);
			},
			assertAtHead: (cursor, state) =>
				assertProjectionAtLogHead(sessionId, cursor, state),
			assertCursorWithinLog: (cursor, state) =>
				assertCursorDoesNotExceedLog(sessionId, cursor, state),
			atHeadState: async () => {
				const state = await ensureProjected(sessionId);
				const current = assertProjectionReady(sessionId);
				return {
					...createReadView(sessionId, current, () =>
						assertCurrentGeneration(sessionId, current)
					),
					state,
				};
			},
		};
	};

	return {
		assertCatalogReadPoint,
		catchUpBoundCatalog: ensureBoundCatalogLogsProjected,
		catchUpRecentModelSelections: ensureRecentModelSelectionsProjected,
		open,
		reconcileDeleted: ensureDeletedSessionsReconciled,
	};
};
