import * as fs from "node:fs/promises";
import type { AgentTurnId, SessionRecord } from "@wincode/agent-core";
import { isCode } from "@wincode/utils";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { EditMode } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import type { SessionCompaction } from "../compaction/types";
import type { SessionContextEdit } from "../context-edits";
import type { Session } from "../session-pagination-types";
import type { PluginSessionStateRecord } from "../session-plugin-state";
import type {
	SessionCatalogPageProjection,
	SessionCatalogPageProjectionInput,
	SessionHistoryPageProjection,
	SessionHistoryPageProjectionInput,
	SessionStatisticsProjection,
} from "./drizzle-session-store";
import type { SessionCatalogIssue, SessionUsageEntry } from "./session-catalog";
import {
	isSessionHistoryEntryEventType,
	type SessionJsonlProjection,
	SessionLogError,
	type SessionLogState,
	type SessionProjectionCursor,
	selectedSessionHistoryPathFromLog,
	sessionProjectionBlocked,
	sessionProjectionCursorsEqual,
	sessionProjectionMatchesState,
} from "./session-jsonl-codec";
import {
	equalBytes,
	firstDifferentByteOffset,
	type SessionLog,
} from "./session-log";
import {
	type SessionHistoryReadPoint,
	type SessionHistoryTreeReadPoint,
	SessionPaginationError,
} from "./session-pagination";

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
	workspaceId?: string;
}>;

export type ProjectedSessionReadPoint =
	| ProjectionReadPoint
	| SessionHistoryTreeReadPoint;

const isProjectionReadPoint = (
	readPoint: ProjectedSessionReadPoint
): readPoint is ProjectionReadPoint =>
	"generation" in readPoint && "projectionId" in readPoint;

export const sessionHistoryTreeProjectionLogId = (
	sessionId: SessionId,
	logId: string,
	projectionId: string,
	generation: number
): string =>
	new Bun.CryptoHasher("sha256")
		.update(JSON.stringify([sessionId, logId, projectionId, generation]))
		.digest("hex");

export type ProjectedSessionRead = Readonly<{
	/** Revalidates this view's captured projection identity without reading rows. */
	assertCurrent: () => void;
	getCompactions: () => Promise<SessionCompaction[]>;
	getEditMode: () => Promise<EditMode>;
	getLatestCompaction: () => Promise<SessionCompaction | null>;
	getSession: () => Promise<Session>;
	getSessionContextEdits: () => Promise<SessionContextEdit[]>;
	readHistoryPage: (
		input: SessionHistoryPageProjectionInput
	) => Promise<SessionHistoryPageProjection>;
	readHistoryTreeLog: () => Promise<SessionLogState>;
	readSessionLog: () => Promise<SessionLogState>;
	readStatistics: (
		readPoint?: SessionHistoryReadPoint,
		turnId?: AgentTurnId
	) => Promise<SessionStatisticsProjection>;
	/** Projection generation this read is bound to. */
	generation: number;
	/** Projection identity this read is bound to. */
	projectionId: string;
	listSessionRecords: () => Promise<SessionRecord[]>;
	listSessionUsageEntries: () => Promise<SessionUsageEntry[]>;
	sessionId: SessionId;
}>;

export type ProjectedSessionStateRead = ProjectedSessionRead &
	Readonly<{
		bytes: Uint8Array;
		/** Reads one Plugin key from this snapshot's selected history path. */
		getPluginSessionState: (
			pluginId: string,
			key: string
		) => PluginSessionStateRecord | undefined;
		state: SessionLogState;
	}>;

const pluginSessionStateFor = (
	state: SessionLogState,
	sessionId: SessionId,
	pluginId: string,
	key: string
): PluginSessionStateRecord | undefined => {
	const selectedHistoryEntryIds = new Set(
		[...selectedSessionHistoryPathFromLog(state, sessionId).entryIds].map(
			String
		)
	);
	let current: PluginSessionStateRecord | undefined;
	for (const { envelope } of state.entries) {
		if (
			(envelope.type === "plugin.state-replaced" ||
				envelope.type === "plugin.state-deleted") &&
			!selectedHistoryEntryIds.has(String(envelope.payload.historyEntryId))
		) {
			continue;
		}
		if (
			envelope.type === "plugin.state-replaced" &&
			envelope.payload.pluginId === pluginId &&
			envelope.payload.key === key
		) {
			current = {
				schemaVersion: Number(envelope.payload.schemaVersion),
				value: envelope.payload.value as PluginSessionStateRecord["value"],
			};
			continue;
		}
		if (
			envelope.type === "plugin.state-deleted" &&
			envelope.payload.pluginId === pluginId &&
			envelope.payload.key === key
		) {
			current = undefined;
		}
	}
	return current;
};

/**
 * The only way for Session JSONL orchestration to read a projection. A handle
 * binds one Session and the projection generation it was opened against; it holds no file descriptor and
 * has no close. `atHead()` catches the projection up to the authoritative log
 * and re-binds the generation after catch-up, while `at(readPoint)`
 * deliberately does not catch up, re-checks the captured point immediately
 * before the read, and fails with `cursor_expired` once it no longer exists.
 */
export type ProjectedSession = Readonly<{
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
		| "withReadyGenerationRead"
		| "workspaceId"
	>;
	projectionStore: Readonly<{
		getCompactions: (sessionId: SessionId) => Promise<SessionCompaction[]>;
		getEditMode: (sessionId: SessionId) => Promise<EditMode>;
		getLatestCompaction: (
			sessionId: SessionId
		) => Promise<SessionCompaction | null>;
		getSession: (sessionId: SessionId) => Promise<Session>;
		getSessionContextEdits: (
			sessionId: SessionId
		) => Promise<SessionContextEdit[]>;
		listRecentModelSelections: (limit: number) => ProviderModelSelection[];
		listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
		listSessionUsageEntries: (
			sessionId: SessionId
		) => Promise<SessionUsageEntry[]>;
		listSessions: () => Promise<Session[]>;
		readSessionCatalogPageProjection: (
			input: SessionCatalogPageProjectionInput
		) => SessionCatalogPageProjection;
		readSessionHistoryPageProjection: (
			sessionId: SessionId,
			input: SessionHistoryPageProjectionInput
		) => SessionHistoryPageProjection;
		readSessionStatisticsProjection: (
			sessionId: SessionId,
			readPoint?: SessionHistoryReadPoint,
			turnId?: AgentTurnId
		) => SessionStatisticsProjection;
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
	listRecentModelSelections: (
		limit: number
	) => Promise<ProviderModelSelection[]>;
	listSessions: () => Promise<Session[]>;
	open: (sessionId: SessionId) => Promise<ProjectedSession>;
	readCatalogPage: (
		input: SessionCatalogPageProjectionInput
	) => Promise<SessionCatalogPageProjection>;
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

	const changedLogBytesSinceProjectionRead = async (
		logPath: string,
		capturedBytes: Uint8Array | undefined
	): Promise<Uint8Array | undefined> => {
		if (capturedBytes === undefined) {
			return;
		}
		try {
			const currentBytes = await Bun.file(logPath).bytes();
			return equalBytes(capturedBytes, currentBytes) ? undefined : currentBytes;
		} catch {
			return;
		}
	};

	const shouldRetryProjectionRead = (
		error: unknown,
		changedLogBytes: Uint8Array | undefined
	): boolean =>
		error instanceof SessionLogError &&
		(error.code === "session_log_corrupt" ||
			error.code === "session_projection_blocked") &&
		projection.getMaintenanceState().status === "ready" &&
		changedLogBytes !== undefined;

	const throwIfProjectionLogWasRewritten = (
		sessionId: SessionId,
		error: unknown,
		capturedBytes: Uint8Array | undefined,
		capturedState: SessionLogState | undefined,
		changedLogBytes: Uint8Array | undefined
	): void => {
		if (
			!(error instanceof SessionLogError) ||
			error.code !== "session_log_corrupt" ||
			capturedBytes === undefined ||
			capturedState === undefined ||
			changedLogBytes === undefined
		) {
			return;
		}
		const appendOnlyChange =
			changedLogBytes.byteLength > capturedBytes.byteLength &&
			equalBytes(
				capturedBytes,
				changedLogBytes.subarray(0, capturedBytes.byteLength)
			);
		if (appendOnlyChange) {
			return;
		}
		const offset = firstDifferentByteOffset(capturedBytes, changedLogBytes);
		if (offset === undefined) {
			return;
		}
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log changed while its projection was being refreshed.",
			{
				cause: error,
				offset,
				sequence: capturedState.nextSequence - 1,
			}
		);
	};

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
	): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
		const generation = assertProjectionReady(sessionId);
		const logPath = await log.logPath(sessionId);
		await assertProjectionSessionBound(sessionId, logPath);
		await ports.checkDeletedMarker(sessionId);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			let capturedBytes: Uint8Array | undefined;
			let capturedState: SessionLogState | undefined;
			try {
				const snapshot = await log.readWithRetry(sessionId);
				capturedBytes = snapshot.bytes;
				const { state } = snapshot;
				capturedState = state;
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
				return snapshot;
			} catch (error) {
				const changedLogBytes = await changedLogBytesSinceProjectionRead(
					logPath,
					capturedBytes
				);
				throwIfProjectionLogWasRewritten(
					sessionId,
					error,
					capturedBytes,
					capturedState,
					changedLogBytes
				);
				if (!shouldRetryProjectionRead(error, changedLogBytes)) {
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

	const ensureProjectedHeadSnapshot = async (
		sessionId: SessionId
	): Promise<
		Readonly<{
			generation: number;
			projectionId: string;
			snapshot: Readonly<{ bytes: Uint8Array; state: SessionLogState }>;
		}>
	> => {
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const snapshot = await ensureProjected(sessionId);
			const generation = assertProjectionReady(sessionId);
			const maintenance = projection.getMaintenanceState();
			if (
				maintenance.status === "ready" &&
				maintenance.generation === generation &&
				sessionProjectionMatchesState(
					projection.getCursor(sessionId),
					snapshot.state,
					generation
				)
			) {
				return {
					generation,
					projectionId: maintenance.projectionId,
					snapshot,
				};
			}
		}
		throw new SessionLogError(
			"session_projection_blocked",
			sessionId,
			"Session projection changed while its head snapshot was being captured."
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

	type RecentModelSelectionsRead = Readonly<{
		cursors: readonly (SessionProjectionCursor | undefined)[];
		generation: number;
		selections: ProviderModelSelection[];
	}>;

	const readRecentModelSelections = (
		sessionIds: readonly SessionId[],
		limit: number
	): RecentModelSelectionsRead => {
		const maintenance = projection.getMaintenanceState();
		const cursors = sessionIds.map((sessionId) =>
			projection.getCursor(sessionId)
		);
		const selections = projection.withReadyGenerationRead(sessionIds, () =>
			projectionStore.listRecentModelSelections(limit)
		);
		return { cursors, generation: maintenance.generation, selections };
	};

	const recentModelSelectionsReadIsCurrent = (
		sessionIds: readonly SessionId[],
		read: RecentModelSelectionsRead
	): boolean => {
		const maintenance = projection.getMaintenanceState();
		return (
			maintenance.status === "ready" &&
			maintenance.generation === read.generation &&
			Bun.deepEquals(sessionIds, projection.listBoundSessionIds(), true) &&
			sessionIds.every((sessionId, index) =>
				sessionProjectionCursorsEqual(
					read.cursors[index],
					projection.getCursor(sessionId)
				)
			)
		);
	};

	const isRetryableGenerationError = (error: unknown): boolean =>
		isCode(error, "session_projection_blocked") &&
		projection.getMaintenanceState().status === "ready";

	type RecentModelSelectionsAttempt =
		| Readonly<{ error?: SessionLogError; kind: "retry" }>
		| Readonly<{ kind: "ready"; selections: ProviderModelSelection[] }>;

	const readRecentModelSelectionsAttempt = async (
		limit: number
	): Promise<RecentModelSelectionsAttempt> => {
		const sessionIds = projection.listBoundSessionIds();
		await ensureRecentModelSelectionsProjected(sessionIds);
		if (!Bun.deepEquals(sessionIds, projection.listBoundSessionIds(), true)) {
			return { kind: "retry" };
		}
		let read: RecentModelSelectionsRead;
		try {
			read = readRecentModelSelections(sessionIds, limit);
		} catch (error) {
			if (!isRetryableGenerationError(error)) {
				throw error;
			}
			return {
				kind: "retry",
				...(error instanceof SessionLogError ? { error } : {}),
			};
		}
		await ensureRecentModelSelectionsProjected(sessionIds);
		return recentModelSelectionsReadIsCurrent(sessionIds, read)
			? { kind: "ready", selections: read.selections }
			: { kind: "retry" };
	};

	const listRecentModelSelections = async (
		limit: number
	): Promise<ProviderModelSelection[]> => {
		if (limit <= 0) {
			return [];
		}
		let lastGenerationError: SessionLogError | undefined;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const result = await readRecentModelSelectionsAttempt(limit);
			if (result.kind === "ready") {
				return result.selections;
			}
			if (result.error !== undefined) {
				lastGenerationError = result.error;
			}
		}
		if (lastGenerationError !== undefined) {
			throw lastGenerationError;
		}
		throw new Error(
			"Session projections kept changing while reading recent Model selections."
		);
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

	const assertReadPointScope = (
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
		if (
			"workspaceId" in readPoint &&
			readPoint.workspaceId !== undefined &&
			readPoint.workspaceId !== projection.workspaceId
		) {
			throw new SessionPaginationError(
				"cursor_invalid",
				"Session read point belongs to a different Workspace."
			);
		}
	};

	const assertProjectionReadPoint = (
		sessionId: SessionId,
		readPoint: ProjectionReadPoint,
		generation: number,
		projectionId: string
	): void => {
		if (readPoint.projectionId !== projectionId) {
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
		if (readPoint.logId === undefined) {
			return;
		}
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
	};

	const assertHistoryTreeReadPoint = (
		sessionId: SessionId,
		readPoint: SessionHistoryTreeReadPoint,
		generation: number,
		projectionId: string
	): void => {
		const cursor = projection.getCursor(sessionId);
		if (
			cursor !== undefined &&
			readPoint.logId ===
				sessionHistoryTreeProjectionLogId(
					sessionId,
					cursor.logId,
					projectionId,
					generation
				)
		) {
			return;
		}
		throw new SessionPaginationError(
			"cursor_expired",
			"Session history tree read point expired after projection maintenance."
		);
	};

	const assertReadPoint = (
		sessionId: SessionId,
		readPoint: ProjectedSessionReadPoint
	): void => {
		assertReadPointScope(sessionId, readPoint);
		const generation = assertProjectionReady(sessionId);
		const { projectionId } = projection.getMaintenanceState();
		if (isProjectionReadPoint(readPoint)) {
			assertProjectionReadPoint(sessionId, readPoint, generation, projectionId);
			return;
		}
		assertHistoryTreeReadPoint(sessionId, readPoint, generation, projectionId);
	};

	const assertCatalogReadPoint = (readPoint: ProjectionReadPoint): void => {
		if (
			readPoint.workspaceId !== undefined &&
			readPoint.workspaceId !== projection.workspaceId
		) {
			throw new SessionPaginationError(
				"cursor_invalid",
				"Session catalog cursor belongs to a different Workspace."
			);
		}
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

	const readCatalogPage = async (
		input: SessionCatalogPageProjectionInput
	): Promise<SessionCatalogPageProjection> => {
		if (input.cursor === undefined) {
			await ensureBoundCatalogLogsProjected();
		} else {
			assertCatalogReadPoint(input.cursor);
		}
		const page = projectionStore.readSessionCatalogPageProjection(input);
		assertCatalogReadPoint(input.cursor ?? page.readPoint);
		return page;
	};

	const listSessions = async (): Promise<Session[]> => {
		const maintenance = projection.getMaintenanceState();
		if (maintenance.status !== "ready") {
			throw sessionProjectionBlocked(
				"Session projection rebuild is incomplete; retry `wincode sessions rebuild` before listing Sessions."
			);
		}
		return await projectionStore.listSessions();
	};

	const assertCurrentGeneration = (
		sessionId: SessionId,
		generation: number,
		projectionId: string
	): void => {
		const maintenance = projection.getMaintenanceState();
		if (
			maintenance.status !== "ready" ||
			maintenance.generation !== generation ||
			maintenance.projectionId !== projectionId
		) {
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
		projectionId: string,
		refreshAtHead: boolean,
		check: () => void
	): ProjectedSessionRead => {
		const runRead = async <Result>(
			operation: () => Promise<Result> | Result
		): Promise<Result> => {
			check();
			if (refreshAtHead) {
				await ensureProjectionCaughtUp(targetSessionId);
			}
			check();
			const result = await operation();
			check();
			return result;
		};
		return {
			assertCurrent: check,
			generation,
			projectionId,
			sessionId: targetSessionId,
			getCompactions: async () =>
				await runRead(() => projectionStore.getCompactions(targetSessionId)),
			getEditMode: async () =>
				await runRead(() => projectionStore.getEditMode(targetSessionId)),
			getLatestCompaction: async () =>
				await runRead(() =>
					projectionStore.getLatestCompaction(targetSessionId)
				),
			getSession: async () =>
				await runRead(() => projectionStore.getSession(targetSessionId)),
			getSessionContextEdits: async () =>
				await runRead(() =>
					projectionStore.getSessionContextEdits(targetSessionId)
				),
			listSessionRecords: async () =>
				await runRead(() =>
					projectionStore.listSessionRecords(targetSessionId)
				),
			listSessionUsageEntries: async () =>
				await runRead(() =>
					projectionStore.listSessionUsageEntries(targetSessionId)
				),
			readHistoryPage: async (input) =>
				await runRead(() =>
					projectionStore.readSessionHistoryPageProjection(
						targetSessionId,
						input
					)
				),
			readHistoryTreeLog: async () =>
				await runRead(
					async () => (await log.readForHistoryTree(targetSessionId)).state
				),
			readSessionLog: async () =>
				await runRead(async () => (await log.read(targetSessionId)).state),
			readStatistics: async (readPoint, turnId) =>
				await runRead(() =>
					projectionStore.readSessionStatisticsProjection(
						targetSessionId,
						readPoint,
						turnId
					)
				),
		};
	};

	const open = async (sessionId: SessionId): Promise<ProjectedSession> => {
		const generation = projection.getMaintenanceState().generation;
		return {
			generation,
			sessionId,
			at: async (readPoint) => {
				assertReadPoint(sessionId, readPoint);
				const maintenance = projection.getMaintenanceState();
				return createReadView(
					sessionId,
					isProjectionReadPoint(readPoint)
						? readPoint.generation
						: maintenance.generation,
					isProjectionReadPoint(readPoint)
						? readPoint.projectionId
						: maintenance.projectionId,
					false,
					() => assertReadPoint(sessionId, readPoint)
				);
			},
			atHead: async () => {
				await ports.reconcileDeletedSessionIfNeeded(sessionId);
				if (!projection.isBoundToWorkspace(sessionId)) {
					throw new Error("Session not found");
				}
				await ensureProjectionCaughtUp(sessionId);
				const maintenance = projection.getMaintenanceState();
				const current = assertProjectionReady(sessionId);
				return createReadView(
					sessionId,
					current,
					maintenance.projectionId,
					true,
					() =>
						assertCurrentGeneration(
							sessionId,
							current,
							maintenance.projectionId
						)
				);
			},
			atHeadState: async () => {
				const {
					generation: current,
					projectionId,
					snapshot,
				} = await ensureProjectedHeadSnapshot(sessionId);
				const { state } = snapshot;
				return {
					...createReadView(sessionId, current, projectionId, true, () =>
						assertCurrentGeneration(sessionId, current, projectionId)
					),
					bytes: snapshot.bytes,
					getPluginSessionState: (pluginId, key) =>
						pluginSessionStateFor(state, sessionId, pluginId, key),
					state,
				};
			},
		};
	};

	return {
		listRecentModelSelections,
		listSessions,
		open,
		readCatalogPage,
		reconcileDeleted: ensureDeletedSessionsReconciled,
	};
};
