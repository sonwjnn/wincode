import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AgentTurnId,
	type ModelStepId,
	type SessionMessageId,
	type SessionRecord,
	type SessionSubmissionStatus,
	type SubmissionId,
	toAgentTurnId,
	toModelStepId,
	toSessionMessageId,
	toSessionRecordId,
	toSubmissionId,
} from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai";
import { isCode, omitUndefined } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import {
	normalizeProviderModelSelection,
	type ProviderModelSelection,
	providerModelSelectionForProviderModel,
} from "@/modules/providers/provider-model-selection";
import type { EditMode } from "@/modules/tools";
import {
	type CompactionId,
	isValidSessionHistoryEntryId,
	isValidSessionId,
	type SessionHistoryEntryId,
	type SessionId,
	toCompactionId,
	toSessionHistoryEntryId,
	toSessionId,
	toSessionUsageEntryId,
} from "@/shared/identifiers";
import { throwIfAborted } from "@/shared/utils/abort";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import { assertCompactionMessageReferences } from "../compaction/validation";
import {
	FAILED_ATTEMPT_CONTEXT_EDIT_OPERATION_PREFIX,
	isFailedAttemptContextEdit,
	type SessionContextEdit,
	sessionContextEditSchema,
} from "../context-edits";
import { withSubmissionStatus } from "../message";
import type {
	SessionBundleExportScope,
	SessionBundleImportResult,
} from "../session-bundle-contract";
import { assessSessionForkCheckpoint } from "../session-fork-checkpoint-validation";
import { isValidSessionLogIdentifier } from "../session-log-identifiers";
import type {
	Session,
	SessionCatalogPage,
	SessionHistoryNavigationRequest,
	SessionHistoryPage,
	SessionHistoryPath,
	SessionHistoryTreeEntry,
	SessionHistoryTreePage,
	SessionPageOptions,
} from "../session-pagination-types";
import {
	copyPluginSessionHistoryPayload,
	type PluginSessionHistoryAppendInput,
	type PluginSessionHistoryAppendResult,
	type PluginSessionHistoryEntry,
	type PluginSessionHistoryPage,
	validatePluginSessionHistoryPluginId,
	validatePluginSessionHistoryType,
} from "../session-plugin-history";
import {
	type PluginSessionStateMutation,
	type PluginSessionStateMutationResult,
	type PluginSessionStateRecord,
	serializePluginSessionStateValue,
	validatePluginSessionStateKey,
	validatePluginSessionStatePluginId,
	validatePluginSessionStateSchemaVersion,
} from "../session-plugin-state";
import {
	type SessionWriteOutcome,
	SessionWriteOutcomeError,
	type SessionWriteReceipt,
} from "../session-write-outcome";
import type {
	SessionStatistics,
	SessionStatisticsOptions,
} from "../usage/session-statistics";
import {
	buildSessionStatistics,
	type SessionStatisticsHistoryPath,
	type SessionUsageContribution,
} from "../usage/session-statistics";
import {
	type AttachmentExternalizationLease,
	type AttachmentIngestLease,
	digestBytes,
} from "./attachment-store";
import type { DrizzleSessionStore } from "./drizzle-session-store";
import { parseSessionLogFileName, resolveSessionLogFilePath } from "./path";
import {
	createProjectedSessionStore,
	type ProjectedSessionStateRead,
} from "./projected-session";
import {
	type PreparedSessionBundleExport,
	type PreparedSessionBundleImport,
	prepareSessionBundleImport,
	SessionBundleImportConflictError,
	type SessionBundleImportFileSystem,
	SessionBundleImportIndeterminateError,
	SessionBundleValidationError,
	validateSessionBundleLog,
} from "./session-bundle";
import type {
	CreateSessionUsageEntryInput,
	SessionCatalog,
	SessionCatalogIssue,
	SessionCatalogResult,
	SessionUsageEntry,
} from "./session-catalog";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	decodeSessionLog,
	encodeCanonicalSessionJson,
	encodeSessionLogLine,
	isSessionHistoryEntryEventType,
	parseSessionCompactionPayload,
	parseSessionContextEditPayload,
	parseSessionForkedPayload,
	parseSessionSubmissionStatusPayload,
	type SessionBundleBranchProvenance,
	type SessionCompactionPayload,
	type SessionForkedPayload,
	type SessionLogEntry,
	type SessionLogEnvelope,
	SessionLogError,
	type SessionLogEventType,
	type SessionLogState,
	type SessionProjectionCursor,
	selectedSessionHistoryPathFromLog,
	sessionHistoryEntryIdForOperation,
	sessionHistoryEntryIdForRecord,
	sessionHistoryPathToEntryFromLog,
	sessionLogOperationDigest,
	sessionProjectionCursorsEqual,
	sessionProjectionMatchesState,
} from "./session-jsonl-codec";
import { rebuildSessionJsonlProjection } from "./session-jsonl-rebuild";
import type {
	CreateEmptySessionInput,
	CreateSessionInput,
	SessionDeletionOutcome,
	SessionForkCheckpoint,
	SessionForkProvenance,
	SessionForkResult,
	SessionForkSubmissionProvenance,
	SessionLifecycle,
	UpdateSessionInput,
} from "./session-lifecycle";
import {
	assertSameSessionWriteIntent,
	type CommittedLogEntry,
	clearSessionForkAction,
	clearSessionForkIntent,
	createSessionLogFile,
	creationDigest,
	deletionReceiptFromEntry,
	ensureDirectoryDurable,
	ensureDurableReceipt,
	equalBytes,
	findOperation,
	firstDifferentByteOffset,
	indeterminateLogWriteError,
	isCanonicalTimestamp,
	isSessionHistoryWrite,
	lockKey,
	operationIdFileStem,
	readExistingSessionLog,
	readLog,
	readSessionForkIntent,
	readSessionImportActivationMarker,
	readSessionWriteIntent,
	removeSessionImportActivationMarker,
	type SessionCreation,
	type SessionDeletionReceipt,
	type SessionForkAction,
	SessionForkError,
	type SessionForkIntent,
	type SessionImportActivationMarker,
	type SessionLogFileIo,
	type SessionWrite,
	type SessionWriteIntent,
	type StagedSessionLog,
	sessionControlRoot,
	sessionDeletionOperationId,
	sessionHistoryReferencesForWrite,
	sessionLogFor,
	stageSessionLog,
	syncAndVerifyLogPrefix,
	syncDirectoryAfterDurablePublication,
	toReceipt,
	validSessionId,
	writeDeletedMarker,
	writeSessionImportActivationMarker,
} from "./session-log";
import {
	decodeSessionHistoryReadPointToken,
	decodeSessionPageToken,
	encodeSessionPageToken,
	parseSessionPageLimit,
	type SessionCatalogPageCursor,
	type SessionHistoryPageCursor,
	type SessionHistoryTreePageCursor,
	type SessionHistoryTreeReadPoint,
	SessionPaginationError,
} from "./session-pagination";
import { buildUserSessionRecord } from "./session-record";
import type {
	CommitSessionRecordInput,
	SessionSubmissionRecordReceipt,
	UpdateSessionSubmissionInput,
} from "./session-records";
import type { SessionStorage } from "./session-storage";
import {
	acquireSessionWriterLock,
	SessionInUseError,
	type SessionWriterLock,
	SessionWriterLockFailureError,
	type SessionWriterLockOptions,
	withSessionCatalogLifecycleGate,
} from "./session-writer-lock";

export type SessionJsonlStoreTestObserver = Readonly<{
	onPluginWriteGenerationValidated?: (
		write: SessionWrite
	) => void | Promise<void>;
	onSessionDeletionWriterOperationEnqueued?: () => void;
}>;

export class SessionCleanupPendingError extends Error {
	readonly code = "session_cleanup_pending" as const;
	readonly operationIds: readonly string[];

	constructor(operationIds: readonly string[], cause?: unknown) {
		super(
			"Session lifecycle cleanup is committed but has not completed.",
			cause === undefined ? undefined : { cause }
		);
		this.name = "SessionCleanupPendingError";
		this.operationIds = operationIds;
	}
}

export class SessionBundleExportCleanupError extends Error {
	readonly code = "session_export_cleanup_failed" as const;

	constructor(cause: unknown) {
		super(
			"Session bundle export finished with an attachment pin or writer cleanup failure.",
			{ cause }
		);
		this.name = "SessionBundleExportCleanupError";
	}
}

export const isCommittedProjectionBlocked = (error: unknown): boolean => {
	const seen = new Set<Error>();
	let current = error;
	while (current instanceof Error && !seen.has(current)) {
		if (
			current instanceof SessionWriteOutcomeError &&
			current.outcome.kind === "committed" &&
			current.outcome.projection === "blocked"
		) {
			return true;
		}
		seen.add(current);
		current = current.cause;
	}
	return false;
};

export const isSessionWriteIndeterminate = (error: unknown): boolean => {
	const seen = new Set<Error>();
	let current = error;
	while (current instanceof Error && !seen.has(current)) {
		if (
			(current instanceof SessionWriteOutcomeError &&
				current.outcome.kind === "indeterminate") ||
			(current instanceof SessionLogError &&
				current.code === "session_log_write_indeterminate") ||
			Reflect.get(current, "code") === "session_log_write_indeterminate"
		) {
			return true;
		}
		seen.add(current);
		current = current.cause;
	}
	return false;
};

export type SessionStorageError = Readonly<{
	code: string;
	message: string;
	writeOutcome?: SessionWriteOutcome;
}>;

export const projectSessionStorageError = (
	error: Error | null
): SessionStorageError | null => {
	if (error instanceof SessionWriteOutcomeError) {
		return {
			code: error.code,
			message: error.message,
			writeOutcome: error.outcome,
		};
	}
	if (error instanceof SessionLogError) {
		return { code: error.code, message: error.message };
	}
	return null;
};

export const sessionWriteOutcomeFromError = (
	operationId: string,
	error: unknown
): SessionWriteOutcome => {
	if (error instanceof SessionWriteOutcomeError) {
		return error.outcome;
	}
	let code = "session_write_failed";
	if (
		error instanceof SessionLogError ||
		error instanceof SessionInUseError ||
		error instanceof SessionWriterLockFailureError
	) {
		code = error.code;
	} else if (
		error instanceof Error &&
		typeof Reflect.get(error, "code") === "string"
	) {
		code = Reflect.get(error, "code");
	} else if (error instanceof Error && error.message === "Session not found") {
		code = "session_not_found";
	}
	const message =
		error instanceof Error ? error.message : "Session write failed.";
	const resolvedOperationId =
		error instanceof SessionLogError
			? (error.operationId ?? operationId)
			: operationId;
	const failure = { code, message };
	if (code === "session_log_write_indeterminate") {
		return {
			error: failure,
			kind: "indeterminate",
			operationId: resolvedOperationId,
			requiresReconciliation: true,
		};
	}
	return {
		error: failure,
		kind: "not-committed",
		operationId: resolvedOperationId,
		retryDisposition:
			code === "session_operation_conflict" ||
			code === "session_log_corrupt" ||
			code === "session_log_truncated" ||
			code === "session_log_version_unsupported" ||
			code === "session_checkpoint_unsupported" ||
			code === "session_deleted" ||
			code === "invalid-boundary" ||
			code === "session_not_found" ||
			code === "session-recovery-required"
				? "do-not-retry"
				: "same-operation",
	};
};

export const requireSessionWriteReady = (
	outcome: SessionWriteOutcome
): SessionWriteReceipt => {
	if (outcome.kind === "committed" && outcome.projection === "ready") {
		return outcome;
	}
	throw new SessionWriteOutcomeError(outcome);
};

type ExpectedPluginHistoryGeneration = Readonly<{
	generation: number;
	message: string;
}>;

const initialRecordFor = (
	input: CreateSessionInput,
	sessionId: SessionId
): SessionRecord => {
	const record = buildUserSessionRecord({
		agentId: input.agent,
		message: input.message,
		model: input.message.metadata?.model ?? input.model,
		thinkingLevel: input.message.metadata?.thinkingLevel ?? input.thinkingLevel,
		turnId: input.turnId,
	});
	return {
		...record,
		id: toSessionRecordId(`initial-${validSessionId(sessionId)}`),
	};
};

const titleFor = (input: CreateSessionInput): string => {
	for (const part of input.message.parts) {
		if (part.type === "text" && part.text.trim()) {
			return part.text.trim();
		}
	}
	return "Untitled Session";
};

const initialCreation = (
	input: CreateEmptySessionInput,
	createdAt: Date
): SessionCreation => ({
	createdAt,
	createdAtIsExplicit: input.createdAt !== undefined,
	editMode: "hashline",
	lastMessageAt: null,
	model: input.model,
	pinned: false,
	thinkingLevel: input.thinkingLevel,
	title: "Untitled Session",
});

const toForkReceipt = (
	entry: SessionLogEntry,
	operationId: string,
	projection: SessionWriteReceipt["projection"]
): SessionWriteReceipt => ({
	...toReceipt(entry, projection),
	operationId,
});

const compactionForAppend = (
	input: AppendSessionCompactionInput,
	id: CompactionId,
	operationId: string,
	state: SessionLogState
): Readonly<{
	compaction: SessionCompaction;
	payload: Readonly<Record<string, unknown>>;
}> => {
	const existingPayload = state.entries.find(
		({ envelope }) => envelope.operationId === operationId
	)?.envelope.payload;
	const sequence =
		existingPayload === undefined
			? state.entries
					.filter(({ envelope }) => envelope.type === "compaction.committed")
					.reduce(
						(latest, { envelope }) =>
							Math.max(latest, Number(envelope.payload.sequence)),
						0
					) + 1
			: Number(existingPayload.sequence);
	const createdAt =
		input.createdAt ??
		(existingPayload === undefined
			? new Date()
			: new Date(String(existingPayload.createdAt)));
	const completedAt =
		input.completedAt ??
		(existingPayload === undefined
			? createdAt
			: new Date(String(existingPayload.completedAt)));
	const priorCompactionId =
		input.priorCompactionId ??
		(existingPayload?.priorCompactionId == null
			? undefined
			: toCompactionId(String(existingPayload.priorCompactionId)));
	const firstKeptAssistantPartIndex =
		input.firstKeptAssistantPartIndex ??
		(existingPayload?.firstKeptAssistantPartIndex == null
			? undefined
			: Number(existingPayload.firstKeptAssistantPartIndex));
	const focus =
		input.focus ??
		(typeof existingPayload?.focus === "string"
			? existingPayload.focus
			: undefined);
	const summarizationThinkingLevel =
		input.summarizationThinkingLevel ??
		(existingPayload?.summarizationThinkingLevel == null
			? undefined
			: (existingPayload.summarizationThinkingLevel as
					| SessionCompaction["summarizationThinkingLevel"]
					| undefined));
	const summarizationUsage =
		input.summarizationUsage ??
		(existingPayload?.summarizationUsage == null
			? undefined
			: (existingPayload.summarizationUsage as
					| SessionCompaction["summarizationUsage"]
					| undefined));
	const { externalizationLease: _externalizationLease, ...compactionInput } =
		input;
	const compaction: SessionCompaction = {
		...compactionInput,
		completedAt,
		createdAt,
		firstKeptAssistantPartIndex,
		focus,
		id,
		priorCompactionId,
		sequence,
		summarizationThinkingLevel,
		summarizationUsage,
	};
	return {
		compaction,
		payload: {
			completedAt: compaction.completedAt.toISOString(),
			createdAt: compaction.createdAt.toISOString(),
			estimatedTokensAfter: compaction.estimatedTokensAfter,
			firstKeptAssistantPartIndex:
				compaction.firstKeptAssistantPartIndex ?? null,
			firstKeptUiMessageId: compaction.firstKeptUiMessageId,
			focus: compaction.focus ?? null,
			id: compaction.id,
			priorCompactionId: compaction.priorCompactionId ?? null,
			sequence: compaction.sequence,
			summarizationModel: compaction.summarizationModel,
			summarizationThinkingLevel: compaction.summarizationThinkingLevel ?? null,
			summarizationUsage: compaction.summarizationUsage ?? null,
			summary: compaction.summary,
			tokensBefore: compaction.tokensBefore,
			trigger: compaction.trigger,
			throughMessageUiId: compaction.throughMessageUiId,
		},
	};
};

type SessionSubmissionRecordMatch = Readonly<{
	entry: SessionLogEntry;
	message: SessionRecord["messages"][number];
	recordId: SessionRecord["id"];
}>;

const recordFromSessionLogEntry = (
	entry: SessionLogEntry
): SessionRecord | undefined => {
	if (entry.envelope.type === "record.committed") {
		return entry.envelope.payload.record as SessionRecord;
	}
	if (entry.envelope.type === "session.created") {
		return entry.envelope.payload.initialRecord as SessionRecord | undefined;
	}
};

type SessionHistoryTreeSnapshot = Readonly<{
	afterSequence: number;
	readPoint: SessionHistoryTreeReadPoint;
	snapshotByteOffset: number;
	snapshotSequence: number;
}>;

type CachedSessionHistoryTreeSnapshot = Readonly<{
	activeLeafId: SessionHistoryEntryId | null;
	historyGeneration: number;
	device: number;
	entries: readonly SessionHistoryTreeEntry[];
	inode: number;
	logPath: string;
	mtimeMs: number;
	ctimeMs: number;
	fileSize: number;
	snapshotByteOffset: number;
	readPoint: SessionHistoryTreeReadPoint;
}>;

// Reuse validated tree snapshots across cursor pages while bounding the number
// of snapshots retained by this store.
const MAX_CACHED_SESSION_HISTORY_TREES = 4;

const sessionHistoryTreeSnapshotCacheKey = (
	readPoint: Pick<
		SessionHistoryTreeReadPoint,
		"sessionId" | "logId" | "readPointSequence" | "lastHash"
	>
): string =>
	`${readPoint.sessionId}\0${readPoint.logId}\0${readPoint.readPointSequence}\0${readPoint.lastHash}`;

const resolveSessionHistoryTreeSnapshot = (
	state: SessionLogState,
	sessionId: SessionId,
	cursor: SessionHistoryTreePageCursor | undefined
): SessionHistoryTreeSnapshot => {
	const readPointSequence = state.nextSequence - 1;
	if (cursor === undefined) {
		return {
			afterSequence: 0,
			readPoint: {
				kind: "history-tree-read-point",
				lastHash: state.lastHash,
				logId: state.logId,
				readPointSequence,
				sessionId,
				version: 1,
			},
			snapshotByteOffset: state.nextOffset,
			snapshotSequence: readPointSequence,
		};
	}
	const snapshotEntry = state.entries.find(
		({ envelope }) => envelope.sequence === cursor.readPointSequence
	);
	if (
		cursor.sessionId !== sessionId ||
		cursor.logId !== state.logId ||
		cursor.readPointSequence > readPointSequence ||
		cursor.afterSequence > cursor.readPointSequence ||
		snapshotEntry?.envelope.entryHash !== cursor.lastHash ||
		snapshotEntry === undefined
	) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session history tree snapshot is no longer available."
		);
	}
	return {
		afterSequence: cursor.afterSequence,
		readPoint: {
			kind: "history-tree-read-point",
			lastHash: cursor.lastHash,
			logId: cursor.logId,
			readPointSequence: cursor.readPointSequence,
			sessionId: cursor.sessionId,
			version: 1,
		},
		snapshotByteOffset: snapshotEntry.endOffset,
		snapshotSequence: cursor.readPointSequence,
	};
};

type SessionHistoryTreeEnvelopeProjection = Readonly<{
	activeLeafId?: SessionHistoryEntryId | null;
	entry?: SessionHistoryTreeEntry;
	historyGeneration?: number;
}>;

const sessionHistoryEntryIdFromPayload = (
	value: unknown
): SessionHistoryEntryId => {
	if (typeof value !== "string") {
		throw new Error("Session history event has an invalid entry ID.");
	}
	return toSessionHistoryEntryId(value);
};

const sessionHistoryEntryIdOrNullFromPayload = (
	value: unknown
): SessionHistoryEntryId | null =>
	value === null ? null : sessionHistoryEntryIdFromPayload(value);

const projectSessionHistoryTreeEnvelope = (
	envelope: SessionLogEnvelope
): SessionHistoryTreeEnvelopeProjection => {
	switch (envelope.type) {
		case "session.created": {
			const record = envelope.payload.initialRecord as
				| SessionRecord
				| undefined;
			return {
				activeLeafId: sessionHistoryEntryIdOrNullFromPayload(
					envelope.payload.activeLeafId
				),
				...(record === undefined
					? {}
					: {
							entry: {
								createdAt: new Date(envelope.timestamp),
								id: sessionHistoryEntryIdFromPayload(
									envelope.payload.initialHistoryEntryId
								),
								kind: "record",
								parentEntryId: null,
								record,
								recordId: record.id,
								selectedPath: false,
								sequence: envelope.sequence,
								...omitUndefined({
									sessionModel: envelope.payload.model as
										| ProviderModelSelection
										| undefined,
									sessionThinkingLevel: envelope.payload.thinkingLevel as
										| ThinkingLevel
										| undefined,
								}),
							},
						}),
			};
		}
		case "session.history-navigated":
			return {
				activeLeafId: sessionHistoryEntryIdOrNullFromPayload(
					envelope.payload.activeLeafId
				),
				historyGeneration: envelope.sequence,
			};
		case "context.edited": {
			const edit = parseSessionContextEditPayload(envelope.payload);
			return {
				activeLeafId: sessionHistoryEntryIdFromPayload(
					envelope.payload.activeLeafId
				),
				entry: {
					createdAt: new Date(envelope.timestamp),
					id: sessionHistoryEntryIdFromPayload(envelope.payload.historyEntryId),
					kind: "context-edit",
					operation: edit.replacement === null ? "omit" : "replace",
					operationId: edit.operationId,
					parentEntryId: sessionHistoryEntryIdOrNullFromPayload(
						envelope.payload.parentEntryId
					),
					selectedPath: false,
					sequence: envelope.sequence,
					targetId: edit.targetId,
				},
			};
		}
		case "submission.status-updated": {
			const status = parseSessionSubmissionStatusPayload(envelope.payload);
			return {
				activeLeafId: sessionHistoryEntryIdFromPayload(
					envelope.payload.activeLeafId
				),
				entry: {
					createdAt: new Date(envelope.timestamp),
					id: sessionHistoryEntryIdFromPayload(envelope.payload.historyEntryId),
					kind: "submission-status",
					...omitUndefined({ failure: status.failure }),
					messageId: toSessionMessageId(status.messageId),
					parentEntryId: sessionHistoryEntryIdOrNullFromPayload(
						envelope.payload.parentEntryId
					),
					recordId: toSessionRecordId(status.recordId),
					selectedPath: false,
					sequence: envelope.sequence,
					status: status.status as SessionSubmissionStatus,
					submissionId: status.submissionId,
				},
			};
		}
		case "compaction.committed": {
			const compaction = parseSessionCompactionPayload(envelope.payload);
			return {
				activeLeafId: sessionHistoryEntryIdFromPayload(
					envelope.payload.activeLeafId
				),
				entry: {
					compactionId: toCompactionId(compaction.id),
					createdAt: new Date(envelope.timestamp),
					id: sessionHistoryEntryIdFromPayload(envelope.payload.historyEntryId),
					kind: "compaction",
					parentEntryId: sessionHistoryEntryIdOrNullFromPayload(
						envelope.payload.parentEntryId
					),
					selectedPath: false,
					sequence: envelope.sequence,
					trigger: compaction.trigger,
				},
			};
		}
		case "record.committed": {
			const record = envelope.payload.record as SessionRecord;
			return {
				activeLeafId: sessionHistoryEntryIdFromPayload(
					envelope.payload.activeLeafId
				),
				entry: {
					createdAt: new Date(envelope.timestamp),
					id: sessionHistoryEntryIdFromPayload(envelope.payload.historyEntryId),
					kind: "record",
					parentEntryId: sessionHistoryEntryIdOrNullFromPayload(
						envelope.payload.parentEntryId
					),
					record,
					recordId: record.id,
					selectedPath: false,
					sequence: envelope.sequence,
					...omitUndefined({
						sessionModel: envelope.payload.sessionModel as
							| ProviderModelSelection
							| undefined,
						sessionThinkingLevel: envelope.payload.sessionThinkingLevel as
							| ThinkingLevel
							| undefined,
					}),
				},
			};
		}
		case "plugin.entry-appended":
			return {
				activeLeafId: sessionHistoryEntryIdFromPayload(
					envelope.payload.activeLeafId
				),
				entry: {
					createdAt: new Date(envelope.timestamp),
					id: sessionHistoryEntryIdFromPayload(envelope.payload.historyEntryId),
					kind: "plugin-entry",
					parentEntryId: sessionHistoryEntryIdOrNullFromPayload(
						envelope.payload.parentEntryId
					),
					pluginId: envelope.payload.pluginId as string,
					selectedPath: false,
					sequence: envelope.sequence,
					type: envelope.payload.entryType as string,
				},
			};
		case "plugin.state-replaced":
		case "plugin.state-deleted":
			return {
				activeLeafId: sessionHistoryEntryIdFromPayload(
					envelope.payload.activeLeafId
				),
				entry: {
					createdAt: new Date(envelope.timestamp),
					id: sessionHistoryEntryIdFromPayload(envelope.payload.historyEntryId),
					key: envelope.payload.key as string,
					kind: "plugin-state",
					operation:
						envelope.type === "plugin.state-replaced" ? "set" : "delete",
					parentEntryId: sessionHistoryEntryIdOrNullFromPayload(
						envelope.payload.parentEntryId
					),
					pluginId: envelope.payload.pluginId as string,
					schemaVersion: envelope.payload.schemaVersion as number,
					selectedPath: false,
					sequence: envelope.sequence,
				},
			};
		default:
			return {};
	}
};

const buildSessionHistoryTreeEntries = (
	state: SessionLogState,
	sessionId: SessionId,
	snapshotSequence: number
): Readonly<{
	activeLeafId: SessionHistoryEntryId | null;
	entries: readonly SessionHistoryTreeEntry[];
	historyGeneration: number;
}> => {
	const nodes: SessionHistoryTreeEntry[] = [];
	let activeLeafId: SessionHistoryEntryId | null = null;
	let historyGeneration = 0;
	for (const { envelope } of state.entries) {
		if (envelope.sequence > snapshotSequence) {
			break;
		}
		const projection = projectSessionHistoryTreeEnvelope(envelope);
		if (projection.entry !== undefined) {
			nodes.push(projection.entry);
		}
		if (projection.activeLeafId !== undefined) {
			activeLeafId = projection.activeLeafId;
		}
		if (projection.historyGeneration !== undefined) {
			historyGeneration = projection.historyGeneration;
		}
	}

	const { entryIds } = selectedSessionHistoryPathFromLog(
		state,
		sessionId,
		snapshotSequence
	);
	return {
		activeLeafId,
		entries: nodes.map((entry) => ({
			...entry,
			selectedPath: entryIds.has(entry.id),
		})),
		historyGeneration,
	};
};

const pageSessionHistoryTree = (
	{
		activeLeafId,
		entries,
		historyGeneration,
	}: Readonly<{
		activeLeafId: SessionHistoryEntryId | null;
		entries: readonly SessionHistoryTreeEntry[];
		historyGeneration: number;
	}>,
	readPoint: SessionHistoryTreeReadPoint,
	afterSequence: number,
	limit: number
): SessionHistoryTreePage => {
	let start = 0;
	let end = entries.length;
	while (start < end) {
		const middle = Math.floor((start + end) / 2);
		const entry = entries[middle];
		if (entry !== undefined && entry.sequence <= afterSequence) {
			start = middle + 1;
		} else {
			end = middle;
		}
	}
	const pageEntries = entries.slice(start, start + limit);
	const lastSequence = pageEntries.at(-1)?.sequence;
	const hasMore = start + pageEntries.length < entries.length;
	const nextCursor =
		hasMore && lastSequence !== undefined
			? encodeSessionPageToken({
					...readPoint,
					afterSequence: lastSequence,
					kind: "history-tree-page",
				})
			: undefined;
	return {
		activeLeafId,
		historyGeneration,
		// Caller mutations must not corrupt the cached snapshot used by later pages.
		entries: structuredClone(pageEntries),
		...omitUndefined({ nextCursor }),
		readPoint: encodeSessionPageToken(readPoint),
	};
};

type SessionForkIdentityMap = Readonly<{
	compactions: ReadonlyMap<string, CompactionId>;
	records: ReadonlyMap<string, SessionRecord["id"]>;
	messages: ReadonlyMap<string, SessionMessageId>;
	turns: ReadonlyMap<string, AgentTurnId>;
	submissions: ReadonlyMap<string, SubmissionId>;
	toolBatches: ReadonlyMap<string, ModelStepId>;
	toolCalls: ReadonlyMap<string, string>;
}>;

type MutableSessionForkIdentityMap = {
	compactions: Map<string, CompactionId>;
	records: Map<string, SessionRecord["id"]>;
	messages: Map<string, SessionMessageId>;
	turns: Map<string, AgentTurnId>;
	submissions: Map<string, SubmissionId>;
	toolBatches: Map<string, ModelStepId>;
	toolCalls: Map<string, string>;
};
type SessionForkToolCallPart = Extract<
	SessionRecord["messages"][number]["parts"][number],
	{ type: "tool-call" }
>;

const remappedForkIdentity = (
	targetSessionId: SessionId,
	kind: string,
	sourceId: string
): string => {
	const digest = new Bun.CryptoHasher("sha256")
		.update(`${targetSessionId}\0${kind}\0${sourceId}`)
		.digest("hex")
		.slice(0, 32);
	return `fork-${kind}-${digest}`;
};

const mapSessionForkCompactionIdentities = (
	targetSessionId: SessionId,
	compactionIds: readonly string[],
	identities: MutableSessionForkIdentityMap
): void => {
	for (const compactionId of compactionIds) {
		identities.compactions.set(
			compactionId,
			toCompactionId(
				remappedForkIdentity(targetSessionId, "compaction", compactionId)
			)
		);
	}
};

const mapSessionForkToolCallIdentities = (
	part: SessionForkToolCallPart,
	targetSessionId: SessionId,
	identities: MutableSessionForkIdentityMap
): void => {
	if (!identities.toolCalls.has(part.toolCallId)) {
		identities.toolCalls.set(
			part.toolCallId,
			remappedForkIdentity(targetSessionId, "tool", part.toolCallId)
		);
	}
	if (part.toolBatch === undefined) {
		return;
	}
	if (!identities.toolBatches.has(part.toolBatch.id)) {
		identities.toolBatches.set(
			part.toolBatch.id,
			toModelStepId(
				remappedForkIdentity(targetSessionId, "tool-batch", part.toolBatch.id)
			)
		);
	}
	for (const toolCallId of part.toolBatch.toolCallIds) {
		if (!identities.toolCalls.has(toolCallId)) {
			identities.toolCalls.set(
				toolCallId,
				remappedForkIdentity(targetSessionId, "tool", toolCallId)
			);
		}
	}
};

const mapSessionForkRecordIdentities = (
	record: SessionRecord,
	targetSessionId: SessionId,
	identities: MutableSessionForkIdentityMap
): void => {
	identities.records.set(
		record.id,
		toSessionRecordId(
			remappedForkIdentity(targetSessionId, "record", record.id)
		)
	);
	identities.turns.set(
		record.turnId,
		toAgentTurnId(remappedForkIdentity(targetSessionId, "turn", record.turnId))
	);
	for (const message of record.messages) {
		identities.messages.set(
			message.id,
			toSessionMessageId(
				remappedForkIdentity(targetSessionId, "message", message.id)
			)
		);
		const submissionId = message.metadata?.submissionId;
		if (
			submissionId !== undefined &&
			!identities.submissions.has(submissionId)
		) {
			identities.submissions.set(
				submissionId,
				toSubmissionId(
					remappedForkIdentity(targetSessionId, "submission", submissionId)
				)
			);
		}
		for (const part of message.parts) {
			if (part.type === "tool-call") {
				mapSessionForkToolCallIdentities(part, targetSessionId, identities);
			}
		}
	}
};

const createSessionForkIdentityMap = (
	targetSessionId: SessionId,
	records: readonly SessionRecord[],
	compactionIds: readonly string[]
): SessionForkIdentityMap => {
	const identities: MutableSessionForkIdentityMap = {
		compactions: new Map(),
		messages: new Map(),
		records: new Map(),
		submissions: new Map(),
		toolBatches: new Map(),
		toolCalls: new Map(),
		turns: new Map(),
	};
	mapSessionForkCompactionIdentities(
		targetSessionId,
		compactionIds,
		identities
	);
	for (const record of records) {
		mapSessionForkRecordIdentities(record, targetSessionId, identities);
	}
	return identities;
};

const toSessionUsageContribution = (
	contribution: SessionForkedPayload["inheritedUsage"][number]
): SessionUsageContribution => {
	const identity = contribution.identity;
	let mappedIdentity: SessionUsageContribution["identity"];
	if (identity.kind === "record") {
		mappedIdentity = {
			kind: "record",
			recordId: toSessionRecordId(identity.recordId),
			sessionId: toSessionId(identity.sessionId),
		};
	} else if (identity.kind === "usage-entry") {
		mappedIdentity = {
			entryId: toSessionUsageEntryId(identity.entryId),
			kind: "usage-entry",
			sessionId: toSessionId(identity.sessionId),
		};
	} else {
		mappedIdentity = {
			compactionId: toCompactionId(identity.compactionId),
			kind: "compaction",
			sessionId: toSessionId(identity.sessionId),
		};
	}
	return {
		...omitUndefined({
			compactionId:
				contribution.compactionId === undefined
					? undefined
					: toCompactionId(contribution.compactionId),
		}),
		cost: contribution.cost,
		identity: mappedIdentity,
		model: contribution.model,
		...omitUndefined({
			turnId:
				contribution.turnId === undefined
					? undefined
					: toAgentTurnId(contribution.turnId),
		}),
		usage: contribution.usage,
	};
};

const toSessionForkProvenance = (value: unknown): SessionForkProvenance => {
	const payload = parseSessionForkedPayload(value);
	return {
		inheritedCompactionIds: payload.inheritedCompactionIds.map(toCompactionId),
		inheritedRecordIds: payload.inheritedRecordIds.map(toSessionRecordId),
		inheritedSubmissions: payload.inheritedSubmissions.map((submission) => ({
			...omitUndefined({ failure: submission.failure }),
			sourceMessageId: toSessionMessageId(submission.sourceMessageId),
			sourceRecordId: toSessionRecordId(submission.sourceRecordId),
			sourceSubmissionId: toSubmissionId(submission.sourceSubmissionId),
			status: submission.status,
			targetMessageId: toSessionMessageId(submission.targetMessageId),
			targetRecordId: toSessionRecordId(submission.targetRecordId),
			targetSubmissionId: toSubmissionId(submission.targetSubmissionId),
		})),
		inheritedUsage: payload.inheritedUsage.map(toSessionUsageContribution),
		sourceLogId: payload.sourceLogId,
		sourceMessageId: toSessionMessageId(payload.sourceMessageId),
		sourceRecordId: toSessionRecordId(payload.sourceRecordId),
		sourceSequence: payload.sourceSequence,
		sourceSessionId: toSessionId(payload.sourceSessionId),
		sourceTurnId: toAgentTurnId(payload.sourceTurnId),
		targetMessageId: toSessionMessageId(payload.targetMessageId),
		targetRecordId: toSessionRecordId(payload.targetRecordId),
		targetTurnId: toAgentTurnId(payload.targetTurnId),
	};
};

const inheritedUsageAtFork = (
	entries: readonly SessionLogEntry[],
	records: readonly SessionRecord[],
	sourceSessionId: SessionId
): SessionUsageContribution[] => {
	const sourceForkEntry = entries.find(
		({ envelope }) => envelope.type === "session.forked"
	);
	const sourceFork =
		sourceForkEntry?.envelope.type === "session.forked"
			? toSessionForkProvenance(sourceForkEntry.envelope.payload)
			: undefined;
	const inheritedRecordIds = new Set(
		sourceFork?.inheritedRecordIds.map(String) ?? []
	);
	const inheritedCompactionIds = new Set(
		sourceFork?.inheritedCompactionIds.map(String) ?? []
	);
	const contributions = [...(sourceFork?.inheritedUsage ?? [])];
	for (const record of records) {
		if (
			inheritedRecordIds.has(record.id) ||
			record.outcome.kind !== "assistant" ||
			record.outcome.terminal.kind !== "completed" ||
			record.outcome.terminal.usage === undefined
		) {
			continue;
		}
		// Record execution settings (such as ThinkingLevel) are not Model identity.
		const model = normalizeProviderModelSelection(
			providerModelSelectionForProviderModel(
				record.model,
				record.model.pluginProviderSource
			)
		);
		if (model === null) {
			throw new Error("Fork prefix contains an invalid Model identity.");
		}
		contributions.push({
			cost: null,
			identity: {
				kind: "record",
				recordId: record.id,
				sessionId: sourceSessionId,
			},
			model,
			turnId: record.turnId,
			usage: record.outcome.terminal.usage,
		});
	}
	const usageEntries = entries.flatMap((entry) => {
		if (entry.envelope.type !== "usage.committed") {
			return [];
		}
		const payload = entry.envelope.payload;
		const model = normalizeProviderModelSelection(payload.model);
		if (model === null) {
			throw new Error("Fork prefix contains an invalid usage Model identity.");
		}
		return [
			{
				...omitUndefined({
					compactionId:
						payload.compactionId === null || payload.compactionId === undefined
							? undefined
							: toCompactionId(String(payload.compactionId)),
				}),
				cost:
					payload.costUsd === null || payload.costUsd === undefined
						? null
						: { amount: Number(payload.costUsd), unit: "USD" },
				identity: {
					entryId: toSessionUsageEntryId(String(payload.id)),
					kind: "usage-entry" as const,
					sessionId: sourceSessionId,
				},
				model,
				usage: payload.usage as SessionUsageContribution["usage"],
			},
		];
	});
	contributions.push(...usageEntries);
	const linkedCompactionIds = new Set(
		entries.flatMap((entry) => {
			if (
				entry.envelope.type !== "usage.committed" ||
				entry.envelope.payload.kind !== "compaction-summary" ||
				entry.envelope.payload.compactionId === null ||
				entry.envelope.payload.compactionId === undefined
			) {
				return [];
			}
			return [String(entry.envelope.payload.compactionId)];
		})
	);
	for (const entry of entries) {
		if (entry.envelope.type !== "compaction.committed") {
			continue;
		}
		const compaction = parseSessionCompactionPayload(entry.envelope.payload);
		if (
			compaction.summarizationUsage === null ||
			linkedCompactionIds.has(compaction.id) ||
			inheritedCompactionIds.has(compaction.id)
		) {
			continue;
		}
		const model = normalizeProviderModelSelection(
			compaction.summarizationModel
		);
		if (model === null) {
			throw new Error(
				"Fork prefix contains an invalid compaction Model identity."
			);
		}
		contributions.push({
			compactionId: toCompactionId(compaction.id),
			cost: null,
			identity: {
				compactionId: toCompactionId(compaction.id),
				kind: "compaction",
				sessionId: sourceSessionId,
			},
			model,
			usage: compaction.summarizationUsage,
		});
	}
	return contributions;
};

const remapForkCompactionPayload = (
	compaction: SessionCompactionPayload,
	sequence: number,
	identityMap: SessionForkIdentityMap,
	copiedSourceCompactionIds: ReadonlySet<string>
): SessionCompactionPayload | undefined => {
	const id = identityMap.compactions.get(compaction.id);
	const firstKeptUiMessageId = identityMap.messages.get(
		compaction.firstKeptUiMessageId
	);
	const throughMessageUiId = identityMap.messages.get(
		compaction.throughMessageUiId
	);
	const coveredMessageIds = compaction.summary.coveredMessageIds.map(
		(messageId) => identityMap.messages.get(messageId)
	);
	const { overflowSourceTurnId: previousOverflowSourceTurnId, ...summary } =
		compaction.summary;
	const overflowSourceTurnId =
		previousOverflowSourceTurnId === undefined
			? undefined
			: identityMap.turns.get(previousOverflowSourceTurnId);
	const priorCompactionId =
		compaction.priorCompactionId === null
			? null
			: identityMap.compactions.get(compaction.priorCompactionId);
	if (
		id === undefined ||
		firstKeptUiMessageId === undefined ||
		throughMessageUiId === undefined ||
		coveredMessageIds.some((messageId) => messageId === undefined) ||
		(compaction.priorCompactionId !== null &&
			(priorCompactionId === undefined ||
				!copiedSourceCompactionIds.has(compaction.priorCompactionId)))
	) {
		return;
	}
	return {
		...compaction,
		firstKeptUiMessageId,
		id,
		priorCompactionId: priorCompactionId ?? null,
		sequence,
		summary: {
			...summary,
			...omitUndefined({ overflowSourceTurnId }),
			coveredMessageIds:
				coveredMessageIds as SessionCompactionPayload["summary"]["coveredMessageIds"],
		},
		throughMessageUiId,
	};
};

const remapForkUsageTurnIds = (
	contributions: readonly SessionUsageContribution[],
	identityMap: SessionForkIdentityMap
): SessionUsageContribution[] =>
	contributions.map((contribution) => ({
		...contribution,
		...omitUndefined({
			compactionId:
				contribution.compactionId === undefined
					? undefined
					: (identityMap.compactions.get(String(contribution.compactionId)) ??
						contribution.compactionId),
			turnId:
				contribution.turnId === undefined
					? undefined
					: (identityMap.turns.get(contribution.turnId) ?? contribution.turnId),
		}),
	}));

const remapForkSessionMetadata = (
	message: SessionRecord["messages"][number],
	identityMap: SessionForkIdentityMap
): SessionRecord["messages"][number]["metadata"] => {
	const metadata = message.metadata;
	if (metadata === undefined) {
		return;
	}
	const submissionId =
		metadata.submissionId === undefined
			? undefined
			: identityMap.submissions.get(metadata.submissionId);
	const sourceUserMessageId =
		metadata.sourceUserMessageId === undefined
			? undefined
			: identityMap.messages.get(metadata.sourceUserMessageId);
	const joinedTurnId =
		metadata.joinedTurnId === undefined
			? undefined
			: identityMap.turns.get(metadata.joinedTurnId);
	if (
		(metadata.submissionId !== undefined && submissionId === undefined) ||
		(metadata.sourceUserMessageId !== undefined &&
			sourceUserMessageId === undefined) ||
		(metadata.joinedTurnId !== undefined && joinedTurnId === undefined)
	) {
		throw new Error("Fork prefix contains a dangling Session reference.");
	}
	const {
		submissionFailure: _failure,
		submissionStatus: _status,
		...metadataWithoutSubmissionState
	} = metadata;
	return {
		...metadataWithoutSubmissionState,
		...omitUndefined({
			joinedTurnId,
			sourceUserMessageId,
			submissionId,
			submissionStatus:
				message.role === "user" && submissionId !== undefined
					? ("processed" as const)
					: undefined,
		}),
	};
};

const remapForkSessionMessagePart = (
	part: SessionRecord["messages"][number]["parts"][number],
	identityMap: SessionForkIdentityMap
): SessionRecord["messages"][number]["parts"][number] => {
	if (part.type !== "tool-call") {
		return part;
	}
	const toolCallId = identityMap.toolCalls.get(part.toolCallId);
	const toolBatchId =
		part.toolBatch === undefined
			? undefined
			: identityMap.toolBatches.get(part.toolBatch.id);
	if (
		toolCallId === undefined ||
		(part.toolBatch !== undefined && toolBatchId === undefined)
	) {
		throw new Error("Fork prefix contains an unmapped Tool Call identity.");
	}
	let toolBatch: NonNullable<typeof part.toolBatch> | undefined;
	if (part.toolBatch !== undefined) {
		const toolCallIds = part.toolBatch.toolCallIds.map((sourceId) => {
			const mappedId = identityMap.toolCalls.get(sourceId);
			if (mappedId === undefined) {
				throw new Error(
					"Fork prefix contains an unmapped Tool Call batch reference."
				);
			}
			return mappedId as NonNullable<
				typeof part.toolBatch
			>["toolCallIds"][number];
		});
		toolBatch = { id: toolBatchId as typeof part.toolBatch.id, toolCallIds };
	}
	return {
		...part,
		toolCallId: toolCallId as typeof part.toolCallId,
		...omitUndefined({ toolBatch }),
	};
};

const remapForkSessionMessage = (
	message: SessionRecord["messages"][number],
	identityMap: SessionForkIdentityMap
): SessionRecord["messages"][number] => {
	const messageId = identityMap.messages.get(message.id);
	if (messageId === undefined) {
		throw new Error("Fork prefix contains an unmapped message identity.");
	}
	return {
		...message,
		id: messageId,
		...omitUndefined({
			metadata: remapForkSessionMetadata(message, identityMap),
		}),
		parts: message.parts.map((part) =>
			remapForkSessionMessagePart(part, identityMap)
		),
	};
};

const remapForkSessionRecord = (
	record: SessionRecord,
	identityMap: SessionForkIdentityMap
): SessionRecord => {
	const recordId = identityMap.records.get(record.id);
	const turnId = identityMap.turns.get(record.turnId);
	if (recordId === undefined || turnId === undefined) {
		throw new Error(
			"Fork prefix contains an unmapped Session Record identity."
		);
	}
	return {
		...record,
		id: recordId,
		turnId,
		messages: record.messages.map((message) =>
			remapForkSessionMessage(message, identityMap)
		),
	};
};

type SourceForkSubmissionStatus = Readonly<{
	failure?: string;
	messageId: SessionMessageId;
	recordId: SessionRecord["id"];
	status?: SessionSubmissionStatus;
	submissionId: SubmissionId;
}>;

const inheritedForkSubmissionsAtCut = (
	entries: readonly SessionLogEntry[],
	records: readonly SessionRecord[],
	identityMap: SessionForkIdentityMap,
	sourceSessionId: SessionId,
	operationId: string
): SessionForkSubmissionProvenance[] => {
	const submissions = new Map<SubmissionId, SourceForkSubmissionStatus>();
	for (const record of records) {
		for (const message of record.messages) {
			const submissionId = message.metadata?.submissionId;
			if (message.role !== "user" || submissionId === undefined) {
				continue;
			}
			if (submissions.has(submissionId)) {
				throw new SessionForkError(
					"session_checkpoint_invalid",
					"Fork prefix contains a duplicate source Submission identity.",
					sourceSessionId,
					operationId
				);
			}
			submissions.set(submissionId, {
				messageId: message.id,
				recordId: record.id,
				submissionId,
				...omitUndefined({
					failure: message.metadata?.submissionFailure,
					status: message.metadata?.submissionStatus,
				}),
			});
		}
	}
	for (const entry of entries) {
		if (entry.envelope.type !== "submission.status-updated") {
			continue;
		}
		const payload = parseSessionSubmissionStatusPayload(entry.envelope.payload);
		const previous = submissions.get(toSubmissionId(payload.submissionId));
		if (
			previous === undefined ||
			previous.messageId !== payload.messageId ||
			previous.recordId !== payload.recordId
		) {
			throw new SessionForkError(
				"session_checkpoint_invalid",
				"Fork prefix contains a Submission status without its source message.",
				sourceSessionId,
				operationId
			);
		}
		submissions.set(previous.submissionId, {
			...previous,
			...omitUndefined({
				failure: payload.status === "failed" ? payload.failure : undefined,
			}),
			status: payload.status,
		});
	}
	return [...submissions.values()].flatMap((submission) => {
		if (submission.status === undefined) {
			return [];
		}
		const targetMessageId = identityMap.messages.get(submission.messageId);
		const targetRecordId = identityMap.records.get(submission.recordId);
		const targetSubmissionId = identityMap.submissions.get(
			submission.submissionId
		);
		if (
			targetMessageId === undefined ||
			targetRecordId === undefined ||
			targetSubmissionId === undefined
		) {
			throw new SessionForkError(
				"session_checkpoint_invalid",
				"Fork prefix contains an unmapped source Submission reference.",
				sourceSessionId,
				operationId
			);
		}
		return [
			{
				...omitUndefined({
					failure:
						submission.status === "failed" ? submission.failure : undefined,
				}),
				sourceMessageId: submission.messageId,
				sourceRecordId: submission.recordId,
				sourceSubmissionId: submission.submissionId,
				status: submission.status,
				targetMessageId,
				targetRecordId,
				targetSubmissionId,
			},
		];
	});
};

type SessionBundleBranchLog = Readonly<{
	logBytes: Uint8Array;
	sessionId: SessionId;
	source: Readonly<{
		activeLeafId: string | null;
		sourceSessionId: string;
	}>;
}>;

const branchOperationIdForHistoryEntry = (
	entry: SessionLogEntry,
	identityMap: SessionForkIdentityMap
): string => {
	const { envelope } = entry;
	switch (envelope.type) {
		case "record.committed": {
			const record = envelope.payload.record as SessionRecord;
			const recordId = identityMap.records.get(record.id);
			if (recordId === undefined) {
				throw new SessionLogError(
					"session_log_corrupt",
					envelope.sessionId,
					"Selected Path Record could not be remapped."
				);
			}
			return `record-${recordId}`;
		}
		case "compaction.committed": {
			const compaction = parseSessionCompactionPayload(envelope.payload);
			const compactionId = identityMap.compactions.get(compaction.id);
			if (compactionId === undefined) {
				throw new SessionLogError(
					"session_log_corrupt",
					envelope.sessionId,
					"Selected Path Compaction could not be remapped."
				);
			}
			return `compaction-${compactionId}`;
		}
		case "context.edited": {
			const edit = parseSessionContextEditPayload(envelope.payload);
			return isFailedAttemptContextEdit(edit.operationId)
				? `${FAILED_ATTEMPT_CONTEXT_EDIT_OPERATION_PREFIX}branch-${envelope.sequence}`
				: `branch-context-${envelope.sequence}`;
		}
		case "submission.status-updated":
		case "plugin.entry-appended":
		case "plugin.state-replaced":
		case "plugin.state-deleted":
			return `branch-${envelope.type.replaceAll(".", "-")}-${envelope.sequence}`;
		default:
			throw new SessionLogError(
				"session_log_corrupt",
				envelope.sessionId,
				"Selected Path contains an unsupported history event."
			);
	}
};

type SessionBundleBranchHistoryProjection = Readonly<{
	activeLeafId: SessionHistoryEntryId | null;
	selectedPathEntries: readonly SessionHistoryTreeEntry[];
	selectedPathEntryIds: ReadonlySet<string>;
	selectedPathHistoryEntries: readonly SessionLogEntry[];
	sourceCompactionIds: readonly string[];
	sourceCompactionPayloads: readonly SessionCompactionPayload[];
	sourceRecords: readonly SessionRecord[];
}>;

const projectSessionBundleBranchHistory = (
	sourceSessionId: SessionId,
	sourceState: SessionLogState
): SessionBundleBranchHistoryProjection => {
	const historyTree = buildSessionHistoryTreeEntries(
		sourceState,
		sourceSessionId,
		sourceState.nextSequence - 1
	);
	const selectedPathEntries = historyTree.entries.filter(
		({ selectedPath }) => selectedPath
	);
	const selectedPathEntryIds = new Set(
		selectedPathEntries.map(({ id }) => String(id))
	);
	const selectedPathHistoryEntries = sourceState.entries.filter(
		({ envelope }) =>
			isSessionHistoryEntryEventType(envelope.type) &&
			selectedPathEntryIds.has(String(envelope.payload.historyEntryId))
	);
	const sourceRecords = selectedPathEntries.flatMap((entry) =>
		entry.kind === "record" ? [entry.record] : []
	);
	const sourceCompactionPayloads = selectedPathHistoryEntries.flatMap(
		({ envelope }) =>
			envelope.type === "compaction.committed"
				? [parseSessionCompactionPayload(envelope.payload)]
				: []
	);
	return {
		activeLeafId: historyTree.activeLeafId,
		selectedPathEntries,
		selectedPathEntryIds,
		selectedPathHistoryEntries,
		sourceCompactionIds: sourceCompactionPayloads.map(({ id }) => id),
		sourceCompactionPayloads,
		sourceRecords,
	};
};

type SessionBundleBranchHistoryIdentity = Readonly<{
	sourceEntryId: string;
	targetEntryId: SessionHistoryEntryId;
	operationId?: string;
}>;

const createSessionBundleBranchHistoryIdentity = (
	sourceSessionId: SessionId,
	targetSessionId: SessionId,
	entry: SessionLogEntry,
	identityMap: SessionForkIdentityMap,
	remappedRecords: ReadonlyMap<string, SessionRecord>
): SessionBundleBranchHistoryIdentity => {
	const sourceEntryId = String(entry.envelope.payload.historyEntryId);
	if (entry.envelope.type === "record.committed") {
		const record = entry.envelope.payload.record as SessionRecord;
		const targetRecord = remappedRecords.get(record.id);
		if (targetRecord === undefined) {
			throw new SessionLogError(
				"session_log_corrupt",
				sourceSessionId,
				"Selected Path Record could not be remapped.",
				{ sequence: entry.envelope.sequence }
			);
		}
		return {
			sourceEntryId,
			targetEntryId: sessionHistoryEntryIdForRecord(
				targetSessionId,
				targetRecord.id
			),
		};
	}
	const operationId = branchOperationIdForHistoryEntry(entry, identityMap);
	return {
		sourceEntryId,
		operationId,
		targetEntryId: sessionHistoryEntryIdForOperation(
			targetSessionId,
			operationId
		),
	};
};

type SessionBundleBranchIdentityProjection = Readonly<{
	historyEntryIds: ReadonlyMap<string, SessionHistoryEntryId>;
	historyOperationIds: ReadonlyMap<string, string>;
	identityMap: SessionForkIdentityMap;
	remappedCompactions: ReadonlyMap<string, SessionCompactionPayload>;
	remappedRecords: ReadonlyMap<string, SessionRecord>;
	sourceCreationPayload: Readonly<Record<string, unknown>>;
	targetInitialHistoryEntryId: SessionHistoryEntryId | undefined;
	targetInitialRecord: SessionRecord | undefined;
	targetSessionId: SessionId;
}>;

const createSessionBundleBranchIdentityProjection = (
	sourceSessionId: SessionId,
	sourceState: SessionLogState,
	historyProjection: SessionBundleBranchHistoryProjection
): SessionBundleBranchIdentityProjection => {
	const {
		selectedPathEntryIds,
		selectedPathHistoryEntries,
		sourceCompactionIds,
		sourceCompactionPayloads,
		sourceRecords,
	} = historyProjection;
	const targetSessionId = toSessionId(randomUUIDv7());
	const identityMap = createSessionForkIdentityMap(
		targetSessionId,
		sourceRecords,
		sourceCompactionIds
	);
	const remappedRecords = new Map(
		sourceRecords.map((record) => [
			record.id,
			remapForkSessionRecord(record, identityMap),
		])
	);
	const remappedCompactions = remapSelectedPathCompactions(
		sourceSessionId,
		sourceCompactionPayloads,
		identityMap
	);
	const sourceCreatedEntry = sourceState.entries.find(
		({ envelope }) => envelope.type === "session.created"
	);
	if (sourceCreatedEntry?.envelope.type !== "session.created") {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Session log is missing its creation checkpoint."
		);
	}
	const sourceCreationPayload = sourceCreatedEntry.envelope.payload;
	const sourceInitialRecord = recordFromSessionLogEntry(sourceCreatedEntry);
	const initialHistoryEntryId = sourceCreationPayload.initialHistoryEntryId;
	const sourceInitialHistoryEntryId =
		typeof initialHistoryEntryId === "string"
			? initialHistoryEntryId
			: undefined;
	const includeInitialRecord =
		sourceInitialRecord !== undefined &&
		sourceInitialHistoryEntryId !== undefined &&
		selectedPathEntryIds.has(sourceInitialHistoryEntryId);
	let targetInitialRecord: SessionRecord | undefined;
	if (includeInitialRecord && sourceInitialRecord !== undefined) {
		targetInitialRecord = remappedRecords.get(sourceInitialRecord.id);
		if (targetInitialRecord === undefined) {
			throw new SessionLogError(
				"session_log_corrupt",
				sourceSessionId,
				"Selected Path initial Record could not be remapped."
			);
		}
	}
	const targetInitialHistoryEntryId =
		targetInitialRecord === undefined
			? undefined
			: sessionHistoryEntryIdForRecord(targetSessionId, targetInitialRecord.id);
	const historyEntryIds = new Map<string, SessionHistoryEntryId>();
	const historyOperationIds = new Map<string, string>();
	if (
		sourceInitialHistoryEntryId !== undefined &&
		targetInitialHistoryEntryId !== undefined
	) {
		historyEntryIds.set(
			sourceInitialHistoryEntryId,
			targetInitialHistoryEntryId
		);
	}
	for (const entry of selectedPathHistoryEntries) {
		const identity = createSessionBundleBranchHistoryIdentity(
			sourceSessionId,
			targetSessionId,
			entry,
			identityMap,
			remappedRecords
		);
		historyEntryIds.set(identity.sourceEntryId, identity.targetEntryId);
		if (identity.operationId !== undefined) {
			historyOperationIds.set(identity.sourceEntryId, identity.operationId);
		}
	}
	return {
		historyEntryIds,
		historyOperationIds,
		identityMap,
		remappedCompactions,
		remappedRecords,
		sourceCreationPayload,
		targetInitialHistoryEntryId,
		targetInitialRecord,
		targetSessionId,
	};
};

const remapSelectedPathCompactions = (
	sourceSessionId: SessionId,
	sourceCompactions: readonly SessionCompactionPayload[],
	identityMap: SessionForkIdentityMap
): ReadonlyMap<string, SessionCompactionPayload> => {
	const remappedCompactions = new Map<string, SessionCompactionPayload>();
	const copiedSourceCompactionIds = new Set<string>();
	for (const compaction of sourceCompactions) {
		const remapped = remapForkCompactionPayload(
			compaction,
			remappedCompactions.size + 1,
			identityMap,
			copiedSourceCompactionIds
		);
		if (remapped === undefined) {
			throw new SessionLogError(
				"session_log_corrupt",
				sourceSessionId,
				"Selected Path Compaction references history outside the Selected Path."
			);
		}
		remappedCompactions.set(compaction.id, remapped);
		copiedSourceCompactionIds.add(compaction.id);
	}
	return remappedCompactions;
};

const isSessionBundleBranchUsageSourceEntry = (
	entry: SessionLogEntry,
	selectedPathEntryIds: ReadonlySet<string>,
	selectedPathCompactionIds: ReadonlySet<string>
): boolean => {
	const { envelope } = entry;
	if (envelope.type === "session.forked") {
		return true;
	}
	if (isSessionHistoryEntryEventType(envelope.type)) {
		return selectedPathEntryIds.has(String(envelope.payload.historyEntryId));
	}
	if (envelope.type !== "usage.committed") {
		return false;
	}
	return (
		envelope.payload.kind === "compaction-summary" &&
		envelope.payload.compactionId !== null &&
		envelope.payload.compactionId !== undefined &&
		selectedPathCompactionIds.has(String(envelope.payload.compactionId))
	);
};

const filterSessionUsageToSelectedPath = (
	contributions: readonly SessionUsageContribution[],
	selectedPathRecords: readonly SessionRecord[],
	selectedPathCompactionIds: ReadonlySet<string>
): SessionUsageContribution[] => {
	const selectedPathTurnIds = new Set(
		selectedPathRecords.map(({ turnId }) => String(turnId))
	);
	return contributions.filter(
		({ compactionId, turnId }) =>
			(turnId !== undefined && selectedPathTurnIds.has(String(turnId))) ||
			(compactionId !== undefined &&
				selectedPathCompactionIds.has(String(compactionId)))
	);
};

type SessionBundleBranchCheckpoint = Readonly<{
	messageId: SessionMessageId;
	record: SessionRecord;
	recordId: SessionRecord["id"];
}>;

const latestValidSessionBundleBranchCheckpoint = (
	records: readonly SessionRecord[]
): SessionBundleBranchCheckpoint | undefined => {
	let checkpoint: SessionBundleBranchCheckpoint | undefined;
	for (const record of records) {
		const candidate = assessSessionForkCheckpoint(records, record.id);
		if (candidate.kind === "valid") {
			checkpoint = candidate;
		}
	}
	return checkpoint;
};

const createSessionBundleBranchInheritedUsage = (
	sourceSessionId: SessionId,
	sourceState: SessionLogState,
	historyProjection: SessionBundleBranchHistoryProjection,
	identityMap: SessionForkIdentityMap
): readonly SessionUsageContribution[] => {
	const selectedPathCompactionIds = new Set(
		historyProjection.sourceCompactionIds.map(String)
	);
	const usageSourceEntries = sourceState.entries.filter((entry) =>
		isSessionBundleBranchUsageSourceEntry(
			entry,
			historyProjection.selectedPathEntryIds,
			selectedPathCompactionIds
		)
	);
	const inheritedAtFork = inheritedUsageAtFork(
		usageSourceEntries,
		historyProjection.sourceRecords,
		sourceSessionId
	);
	const selectedPathUsage = filterSessionUsageToSelectedPath(
		inheritedAtFork,
		historyProjection.sourceRecords,
		selectedPathCompactionIds
	);
	return remapForkUsageTurnIds(selectedPathUsage, identityMap);
};

const createSessionBundleBranchForkPayload = (
	sourceSessionId: SessionId,
	sourceState: SessionLogState,
	historyProjection: SessionBundleBranchHistoryProjection,
	identityProjection: SessionBundleBranchIdentityProjection,
	inheritedUsage: readonly SessionUsageContribution[]
): SessionForkedPayload | undefined => {
	const checkpoint = latestValidSessionBundleBranchCheckpoint(
		historyProjection.sourceRecords
	);
	if (checkpoint === undefined) {
		if (inheritedUsage.length > 0) {
			throw new SessionLogError(
				"session_log_corrupt",
				sourceSessionId,
				"Selected Path usage cannot be marked inherited without a valid checkpoint."
			);
		}
		return;
	}
	const checkpointEntry = sourceState.entries.find(
		(entry) => recordFromSessionLogEntry(entry)?.id === checkpoint.record.id
	);
	const targetRecordId = identityProjection.identityMap.records.get(
		checkpoint.recordId
	);
	const targetTurnId = identityProjection.identityMap.turns.get(
		checkpoint.record.turnId
	);
	const targetMessageId = identityProjection.identityMap.messages.get(
		checkpoint.messageId
	);
	if (
		checkpointEntry === undefined ||
		targetRecordId === undefined ||
		targetTurnId === undefined ||
		targetMessageId === undefined
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path checkpoint could not be remapped."
		);
	}
	const inheritedSubmissions = inheritedForkSubmissionsAtCut(
		historyProjection.selectedPathHistoryEntries,
		historyProjection.sourceRecords,
		identityProjection.identityMap,
		sourceSessionId,
		`branch-${identityProjection.targetSessionId}`
	);
	const inheritedCompactionIds = historyProjection.sourceCompactionIds.flatMap(
		(id) => {
			const mapped = identityProjection.identityMap.compactions.get(id);
			return mapped === undefined ? [] : [mapped];
		}
	);
	const inheritedRecordIds = historyProjection.sourceRecords.flatMap(
		(record) => {
			const mapped = identityProjection.identityMap.records.get(record.id);
			return mapped === undefined ? [] : [mapped];
		}
	);
	return {
		inheritedCompactionIds,
		inheritedRecordIds,
		inheritedSubmissions,
		inheritedUsage: [...inheritedUsage],
		sourceLogId: sourceState.logId,
		sourceMessageId: checkpoint.messageId,
		sourceRecordId: checkpoint.recordId,
		sourceSequence: checkpointEntry.envelope.sequence,
		sourceSessionId,
		sourceTurnId: checkpoint.record.turnId,
		targetMessageId,
		targetRecordId,
		targetTurnId,
	};
};

type SessionBundleBranchLogWriter = Readonly<{
	appendEvent: (
		type: SessionLogEventType,
		operationId: string,
		payload: Readonly<Record<string, unknown>>,
		timestamp: string
	) => void;
	createdAt: string;
	toBytes: () => Uint8Array;
}>;

const createSessionBundleBranchLogWriter = (
	targetSessionId: SessionId
): SessionBundleBranchLogWriter => {
	const createdAt = new Date().toISOString();
	const header = createSessionLogHeader(
		targetSessionId,
		randomUUIDv7(),
		createdAt
	);
	const logLines = [encodeSessionLogLine(header)];
	let nextSequence = 1;
	let previousHash = header.entryHash;
	const appendEvent: SessionBundleBranchLogWriter["appendEvent"] = (
		type,
		operationId,
		payload,
		timestamp
	) => {
		const envelope = createSessionLogEvent({
			operationId,
			payload,
			previousHash,
			sequence: nextSequence,
			sessionId: targetSessionId,
			timestamp,
			type,
		});
		logLines.push(encodeSessionLogLine(envelope));
		nextSequence += 1;
		previousHash = envelope.entryHash;
	};
	const toBytes = (): Uint8Array => {
		const byteLength = logLines.reduce(
			(total, line) => total + line.byteLength,
			0
		);
		const logBytes = new Uint8Array(byteLength);
		let byteOffset = 0;
		for (const line of logLines) {
			logBytes.set(line, byteOffset);
			byteOffset += line.byteLength;
		}
		return logBytes;
	};
	return { appendEvent, createdAt, toBytes };
};

const appendSessionBundleBranchCreatedEvent = (
	writer: SessionBundleBranchLogWriter,
	identityProjection: SessionBundleBranchIdentityProjection,
	provenance: SessionBundleBranchProvenance
): void => {
	const {
		activeLeafId: _sourceActiveLeafId,
		initialHistoryEntryId: _sourceInitialHistoryEntryId,
		initialRecord: _sourceInitialRecord,
		lastMessageAt: _sourceLastMessageAt,
		...creationFields
	} = identityProjection.sourceCreationPayload;
	writer.appendEvent(
		"session.created",
		`branch-created-${identityProjection.targetSessionId}`,
		{
			...creationFields,
			bundleProvenance: provenance,
			activeLeafId: identityProjection.targetInitialHistoryEntryId ?? null,
			createdAt: writer.createdAt,
			lastMessageAt:
				identityProjection.targetInitialRecord === undefined
					? null
					: writer.createdAt,
			...omitUndefined({
				initialHistoryEntryId: identityProjection.targetInitialHistoryEntryId,
				initialRecord: identityProjection.targetInitialRecord,
			}),
		},
		writer.createdAt
	);
};

const appendSessionBundleBranchForkEvent = (
	writer: SessionBundleBranchLogWriter,
	targetSessionId: SessionId,
	forkPayload: SessionForkedPayload | undefined
): void => {
	if (forkPayload === undefined) {
		return;
	}
	writer.appendEvent(
		"session.forked",
		`branch-provenance-${targetSessionId}`,
		forkPayload,
		writer.createdAt
	);
};

type SessionBundleBranchEventContext = Readonly<{
	operationId: string | undefined;
	parentEntryId: SessionHistoryEntryId | null;
	targetEntryId: SessionHistoryEntryId;
}>;

const sessionBundleBranchHistoryPayloadFields = (
	context: SessionBundleBranchEventContext
) => ({
	activeLeafId: context.targetEntryId,
	historyEntryId: context.targetEntryId,
	parentEntryId: context.parentEntryId,
});

const remapSessionBundleBranchParentId = (
	sourceSessionId: SessionId,
	historyEntryIds: ReadonlyMap<string, SessionHistoryEntryId>,
	value: unknown,
	sequence: number
): SessionHistoryEntryId | null => {
	if (value === null) {
		return null;
	}
	const mapped = historyEntryIds.get(String(value));
	if (mapped === undefined) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path parent is missing from the exported branch.",
			{ sequence }
		);
	}
	return mapped;
};

const createSessionBundleBranchEventContext = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	historyEntryIds: ReadonlyMap<string, SessionHistoryEntryId>,
	historyOperationIds: ReadonlyMap<string, string>
): SessionBundleBranchEventContext => {
	const sourceEntryId = String(entry.envelope.payload.historyEntryId);
	const targetEntryId = historyEntryIds.get(sourceEntryId);
	if (targetEntryId === undefined) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path history entry could not be remapped.",
			{ sequence: entry.envelope.sequence }
		);
	}
	return {
		operationId: historyOperationIds.get(sourceEntryId),
		parentEntryId: remapSessionBundleBranchParentId(
			sourceSessionId,
			historyEntryIds,
			entry.envelope.payload.parentEntryId,
			entry.envelope.sequence
		),
		targetEntryId,
	};
};

const requireSessionBundleBranchOperationId = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	context: SessionBundleBranchEventContext
): string => {
	if (context.operationId === undefined) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path event operation could not be remapped.",
			{ sequence: entry.envelope.sequence }
		);
	}
	return context.operationId;
};

const appendSessionBundleBranchRecordEvent = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	context: SessionBundleBranchEventContext,
	remappedRecords: ReadonlyMap<string, SessionRecord>,
	writer: SessionBundleBranchLogWriter
): void => {
	const sourceRecord = entry.envelope.payload.record as SessionRecord;
	const record = remappedRecords.get(sourceRecord.id);
	if (record === undefined) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path Record could not be remapped.",
			{ sequence: entry.envelope.sequence }
		);
	}
	writer.appendEvent(
		"record.committed",
		`record-${record.id}`,
		{
			...entry.envelope.payload,
			...sessionBundleBranchHistoryPayloadFields(context),
			record,
		},
		entry.envelope.timestamp
	);
};

const appendSessionBundleBranchContextEditEvent = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	context: SessionBundleBranchEventContext,
	identityMap: SessionForkIdentityMap,
	writer: SessionBundleBranchLogWriter
): void => {
	const edit = parseSessionContextEditPayload(entry.envelope.payload);
	const targetId = identityMap.messages.get(edit.targetId);
	if (targetId === undefined) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path context edit target could not be remapped.",
			{ sequence: entry.envelope.sequence }
		);
	}
	const operationId = requireSessionBundleBranchOperationId(
		sourceSessionId,
		entry,
		context
	);
	writer.appendEvent(
		"context.edited",
		operationId,
		{
			...edit,
			...sessionBundleBranchHistoryPayloadFields(context),
			operationId,
			targetId,
		},
		entry.envelope.timestamp
	);
};

const appendSessionBundleBranchSubmissionStatusEvent = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	context: SessionBundleBranchEventContext,
	identityMap: SessionForkIdentityMap,
	writer: SessionBundleBranchLogWriter
): void => {
	const submission = parseSessionSubmissionStatusPayload(
		entry.envelope.payload
	);
	const messageId = identityMap.messages.get(submission.messageId);
	const recordId = identityMap.records.get(submission.recordId);
	const submissionId = identityMap.submissions.get(submission.submissionId);
	if (
		messageId === undefined ||
		recordId === undefined ||
		submissionId === undefined
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path Submission status could not be remapped.",
			{ sequence: entry.envelope.sequence }
		);
	}
	const operationId = requireSessionBundleBranchOperationId(
		sourceSessionId,
		entry,
		context
	);
	writer.appendEvent(
		"submission.status-updated",
		operationId,
		{
			...sessionBundleBranchHistoryPayloadFields(context),
			messageId,
			recordId,
			status: "processed",
			submissionId,
		},
		entry.envelope.timestamp
	);
};

const appendSessionBundleBranchCompactionEvent = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	context: SessionBundleBranchEventContext,
	remappedCompactions: ReadonlyMap<string, SessionCompactionPayload>,
	writer: SessionBundleBranchLogWriter
): void => {
	const sourceCompaction = parseSessionCompactionPayload(
		entry.envelope.payload
	);
	const compaction = remappedCompactions.get(sourceCompaction.id);
	if (compaction === undefined) {
		throw new SessionLogError(
			"session_log_corrupt",
			sourceSessionId,
			"Selected Path Compaction could not be remapped.",
			{ sequence: entry.envelope.sequence }
		);
	}
	const operationId = requireSessionBundleBranchOperationId(
		sourceSessionId,
		entry,
		context
	);
	writer.appendEvent(
		"compaction.committed",
		operationId,
		{
			...compaction,
			...sessionBundleBranchHistoryPayloadFields(context),
		},
		entry.envelope.timestamp
	);
};

const appendSessionBundleBranchOpaqueHistoryEvent = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	context: SessionBundleBranchEventContext,
	writer: SessionBundleBranchLogWriter
): void => {
	const operationId = requireSessionBundleBranchOperationId(
		sourceSessionId,
		entry,
		context
	);
	writer.appendEvent(
		entry.envelope.type,
		operationId,
		{
			...entry.envelope.payload,
			...sessionBundleBranchHistoryPayloadFields(context),
		},
		entry.envelope.timestamp
	);
};

const appendSessionBundleBranchHistoryEvent = (
	sourceSessionId: SessionId,
	entry: SessionLogEntry,
	historyEntryIds: ReadonlyMap<string, SessionHistoryEntryId>,
	historyOperationIds: ReadonlyMap<string, string>,
	identityMap: SessionForkIdentityMap,
	remappedRecords: ReadonlyMap<string, SessionRecord>,
	remappedCompactions: ReadonlyMap<string, SessionCompactionPayload>,
	writer: SessionBundleBranchLogWriter
): void => {
	const { envelope } = entry;
	if (!isSessionHistoryEntryEventType(envelope.type)) {
		return;
	}
	const context = createSessionBundleBranchEventContext(
		sourceSessionId,
		entry,
		historyEntryIds,
		historyOperationIds
	);
	switch (envelope.type) {
		case "record.committed":
			appendSessionBundleBranchRecordEvent(
				sourceSessionId,
				entry,
				context,
				remappedRecords,
				writer
			);
			return;
		case "context.edited":
			appendSessionBundleBranchContextEditEvent(
				sourceSessionId,
				entry,
				context,
				identityMap,
				writer
			);
			return;
		case "submission.status-updated":
			appendSessionBundleBranchSubmissionStatusEvent(
				sourceSessionId,
				entry,
				context,
				identityMap,
				writer
			);
			return;
		case "compaction.committed":
			appendSessionBundleBranchCompactionEvent(
				sourceSessionId,
				entry,
				context,
				remappedCompactions,
				writer
			);
			return;
		default:
			appendSessionBundleBranchOpaqueHistoryEvent(
				sourceSessionId,
				entry,
				context,
				writer
			);
	}
};

const appendSessionBundleBranchLogEntries = (
	sourceSessionId: SessionId,
	sourceState: SessionLogState,
	historyProjection: SessionBundleBranchHistoryProjection,
	identityProjection: SessionBundleBranchIdentityProjection,
	writer: SessionBundleBranchLogWriter
): void => {
	for (const entry of sourceState.entries) {
		const { envelope } = entry;
		if (envelope.type === "session.metadata-updated") {
			writer.appendEvent(
				"session.metadata-updated",
				`branch-metadata-${envelope.sequence}`,
				envelope.payload,
				envelope.timestamp
			);
			continue;
		}
		if (!isSessionHistoryEntryEventType(envelope.type)) {
			continue;
		}
		if (
			!historyProjection.selectedPathEntryIds.has(
				String(envelope.payload.historyEntryId)
			)
		) {
			continue;
		}
		appendSessionBundleBranchHistoryEvent(
			sourceSessionId,
			entry,
			identityProjection.historyEntryIds,
			identityProjection.historyOperationIds,
			identityProjection.identityMap,
			identityProjection.remappedRecords,
			identityProjection.remappedCompactions,
			writer
		);
	}
};

const createSessionBundleBranchLog = (
	sourceSessionId: SessionId,
	sourceState: SessionLogState
): SessionBundleBranchLog => {
	const historyProjection = projectSessionBundleBranchHistory(
		sourceSessionId,
		sourceState
	);
	const activeLeafId = historyProjection.activeLeafId;
	const identityProjection = createSessionBundleBranchIdentityProjection(
		sourceSessionId,
		sourceState,
		historyProjection
	);
	const targetSessionId = identityProjection.targetSessionId;
	const inheritedUsage = createSessionBundleBranchInheritedUsage(
		sourceSessionId,
		sourceState,
		historyProjection,
		identityProjection.identityMap
	);
	const forkPayload = createSessionBundleBranchForkPayload(
		sourceSessionId,
		sourceState,
		historyProjection,
		identityProjection,
		inheritedUsage
	);

	const writer = createSessionBundleBranchLogWriter(targetSessionId);
	appendSessionBundleBranchCreatedEvent(writer, identityProjection, {
		activeLeafId,
		sourceSessionId,
	});
	appendSessionBundleBranchForkEvent(writer, targetSessionId, forkPayload);

	appendSessionBundleBranchLogEntries(
		sourceSessionId,
		sourceState,
		historyProjection,
		identityProjection,
		writer
	);
	const logBytes = writer.toBytes();
	decodeSessionLog(targetSessionId, logBytes);
	return {
		logBytes,
		sessionId: targetSessionId,
		source: {
			activeLeafId,
			sourceSessionId,
		},
	};
};

const findSessionSubmissionRecord = (
	entries: readonly SessionLogEntry[],

	sessionId: SessionId,
	submissionId: SubmissionId
): SessionSubmissionRecordMatch | undefined => {
	const matches = entries.flatMap((entry) => {
		const record = recordFromSessionLogEntry(entry);
		if (record === undefined) {
			return [];
		}
		const message = record.messages.find(
			(candidate) =>
				candidate.role === "user" &&
				candidate.metadata?.submissionId === submissionId
		);
		return message === undefined
			? []
			: [{ entry, message, recordId: record.id }];
	});
	if (matches.length > 1) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session Submission identity is committed more than once."
		);
	}
	return matches[0];
};

const requirePublishedForkEntries = (
	state: SessionLogState,
	sourceSessionId: SessionId,
	checkpointRecordId: string,
	operationId: string,
	forkOperationLogId: string
): Readonly<{
	createdEntry: SessionLogEntry;
	forked: SessionForkedPayload;
	forkedEntry: SessionLogEntry;
}> => {
	const forkEntry = state.entries.find(
		({ envelope }) =>
			envelope.operationId === forkOperationLogId &&
			envelope.type === "session.forked"
	);
	const createdEntry = state.entries.find(
		({ envelope }) =>
			envelope.sequence === 1 && envelope.type === "session.created"
	);
	if (
		forkEntry?.envelope.type !== "session.forked" ||
		createdEntry?.envelope.type !== "session.created" ||
		forkEntry.envelope.payload.sourceSessionId !== sourceSessionId ||
		forkEntry.envelope.payload.sourceRecordId !== checkpointRecordId
	) {
		throw new SessionForkError(
			"session_operation_conflict",
			"Published Session does not match its durable fork operation intent.",
			sourceSessionId,
			operationId
		);
	}
	return {
		createdEntry,
		forked: parseSessionForkedPayload(forkEntry.envelope.payload),
		forkedEntry: forkEntry,
	};
};

export const createSessionJsonlStore = (
	projectionStore: DrizzleSessionStore,
	logRoot: string,
	fileIo: SessionLogFileIo = {},
	testObserver?: SessionJsonlStoreTestObserver
): SessionStorage => {
	const projection = projectionStore.jsonlProjection;
	const sessionLog = sessionLogFor(logRoot, fileIo);

	const pendingCreationAttachmentLeases = new Map<
		SessionId,
		AttachmentExternalizationLease
	>();
	const pendingAttachmentLeases = new Map<
		SessionId,
		Set<{
			operationId: string;
			lease: AttachmentExternalizationLease;
		}>
	>();
	const heldWriterKeys = new Set<string>();
	const sessionHistoryTreeSnapshotCache = new Map<
		string,
		CachedSessionHistoryTreeSnapshot
	>();

	const withAppendQueues = async <Result>(
		sessionIds: readonly SessionId[],
		operation: () => Promise<Result>
	): Promise<Result> => await sessionLog.withAppendQueue(sessionIds, operation);

	const deletedMarkerPath = async (sessionId: SessionId): Promise<string> =>
		path.join(
			await sessionControlRoot(logRoot),
			"deleted",
			`${validSessionId(sessionId)}.json`
		);

	const checkDeletedMarker = async (sessionId: SessionId): Promise<void> => {
		try {
			await fs.access(await deletedMarkerPath(sessionId));
		} catch (error) {
			if (isCode(error, "ENOENT")) {
				return;
			}
			throw error;
		}
		throw new SessionLogError(
			"session_deleted",
			sessionId,
			"Session has a durable deletion marker and cannot be reopened."
		);
	};

	const projected = createProjectedSessionStore({
		assertNoUnresolvedOwnedSessionCreations: async (root) =>
			await assertNoUnresolvedOwnedSessionCreations(root),
		checkDeletedMarker: async (sessionId) =>
			await checkDeletedMarker(sessionId),
		hasPendingAttachmentRecovery: (sessionId) =>
			pendingCreationAttachmentLeases.has(sessionId) ||
			pendingAttachmentLeases.has(sessionId),
		log: sessionLog,
		projection,
		projectionStore: {
			getCompactions: async (sessionId) =>
				await projectionStore.getCompactions(sessionId),
			getEditMode: async (sessionId) =>
				await projectionStore.getEditMode(sessionId),
			getLatestCompaction: async (sessionId) =>
				await projectionStore.getLatestCompaction(sessionId),
			getSession: async (sessionId) =>
				await projectionStore.getSession(sessionId),
			listSessionRecords: async (sessionId) =>
				await projectionStore.listSessionRecords(sessionId),
			listSessionUsageEntries: async (sessionId) =>
				await projectionStore.listSessionUsageEntries(sessionId),
		},
		reconcileDeletedSessionIfNeeded: async (sessionId) =>
			await reconcileDeletedSessionIfNeeded(sessionId),
		reconcileDeletedSessions: async () => await reconcileDeletedSessions(),
		reconcileSidecars: async (sessionId, logPath, bytes, state) =>
			await reconcileProjectionSessionSidecars(
				sessionId,
				logPath,
				bytes,
				state
			),
	});

	const assertSessionHistoryWorkspaceBinding = (
		sessionId: SessionId,
		cursor: SessionHistoryPageCursor | SessionHistoryTreePageCursor | undefined
	): void => {
		if (projection.isBoundToWorkspace(sessionId)) {
			return;
		}
		if (cursor !== undefined) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session history cursor expired because the Session was deleted."
			);
		}
		throw new Error("Session not found");
	};

	const assertSessionStatisticsWorkspaceBinding = (
		sessionId: SessionId,
		hasReadPoint: boolean
	): void => {
		if (projection.isBoundToWorkspace(sessionId)) {
			return;
		}
		if (hasReadPoint) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session statistics read point expired because the Session was deleted."
			);
		}
		throw new Error("Session not found");
	};

	const assertSessionWritable = async (sessionId: SessionId): Promise<void> => {
		await checkDeletedMarker(sessionId);
		if (projection.isBoundToAnotherWorkspace(sessionId)) {
			throw new Error("Session not found");
		}
	};

	const releasePendingCreationAttachmentLease = async (
		sessionId: SessionId,
		lease: AttachmentExternalizationLease
	): Promise<void> => {
		try {
			await lease.release();
		} catch {
			pendingCreationAttachmentLeases.set(sessionId, lease);
			return;
		}
		if (pendingCreationAttachmentLeases.get(sessionId) === lease) {
			pendingCreationAttachmentLeases.delete(sessionId);
		}
	};

	const releaseReconciledAttachmentLeases = async (
		sessionId: SessionId,
		state: SessionLogState
	): Promise<void> => {
		const leases = pendingAttachmentLeases.get(sessionId);
		if (leases === undefined) {
			return;
		}
		const pendingIntent = await sessionLog.readWriteIntent(sessionId);
		const committedOperationIds = new Set(
			state.entries.map(({ envelope }) => envelope.operationId)
		);
		for (const pending of leases) {
			if (
				!committedOperationIds.has(pending.operationId) &&
				pendingIntent !== undefined
			) {
				continue;
			}
			try {
				await pending.lease.release();
			} catch {
				continue;
			}
			leases.delete(pending);
		}
		if (leases.size === 0) {
			pendingAttachmentLeases.delete(sessionId);
		}
	};

	const reconcileProjectionSessionSidecars = async (
		sessionId: SessionId,
		logPath: string,
		bytes: Uint8Array,
		state: SessionLogState
	): Promise<void> => {
		await sessionLog.reconcileVisibleWriteIntent(
			sessionId,
			logPath,
			bytes,
			state,
			projection.workspaceId
		);
		await releaseReconciledAttachmentLeases(sessionId, state);
		const pendingCreationLease = pendingCreationAttachmentLeases.get(sessionId);
		if (
			pendingCreationLease !== undefined &&
			state.entries.some(
				({ envelope }) =>
					envelope.operationId === `create-${sessionId}` &&
					envelope.type === "session.created"
			)
		) {
			await releasePendingCreationAttachmentLease(
				sessionId,
				pendingCreationLease
			);
		}
	};

	const pendingAppendTimestamps = (
		state: SessionLogState,
		intent: SessionWriteIntent,
		sessionId: SessionId
	):
		| Readonly<{ createdAt?: string; envelopeTimestamp?: string }>
		| undefined => {
		const entry = state.entries.find(
			({ envelope }) => envelope.sequence === intent.sequence
		);
		if (entry === undefined) {
			return;
		}
		assertSameSessionWriteIntent(
			intent,
			{
				operationDigest: sessionLogOperationDigest(
					entry.envelope.type,
					entry.envelope.payload
				),
				operationId: entry.envelope.operationId,
				type: entry.envelope.type,
			},
			sessionId
		);
		if (intent.type !== "compaction.committed") {
			return;
		}
		const createdAt = entry.envelope.payload.createdAt;
		const envelopeTimestamp = entry.envelope.timestamp;
		if (
			!(
				isCanonicalTimestamp(createdAt) &&
				isCanonicalTimestamp(envelopeTimestamp)
			)
		) {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Pending compaction timestamps cannot be recovered safely.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		return { createdAt, envelopeTimestamp };
	};

	const stateForPendingAppend = async (
		sessionId: SessionId,
		intent: SessionWriteIntent
	): Promise<
		Readonly<{
			createdAt?: string;
			envelopeTimestamp?: string;
			state: SessionLogState;
		}>
	> => {
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
		);
		const bytes = await Bun.file(logPath).bytes();
		try {
			const state = decodeSessionLog(sessionId, bytes);
			return {
				...pendingAppendTimestamps(state, intent, sessionId),
				state,
			};
		} catch (error) {
			if (
				!(error instanceof SessionLogError) ||
				error.code !== "session_log_truncated"
			) {
				throw error;
			}
		}
		if (bytes.byteLength < intent.expectedOffset) {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Session log is shorter than its pending write boundary.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		const state = decodeSessionLog(
			sessionId,
			bytes.subarray(0, intent.expectedOffset)
		);
		if (
			state.nextOffset !== intent.expectedOffset ||
			state.nextSequence !== intent.sequence
		) {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Session log prefix does not match its pending write boundary.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		let timestamps:
			| Readonly<{
					createdAt?: string;
					envelopeTimestamp?: string;
			  }>
			| undefined;
		const unframedBytes = new Uint8Array(bytes.byteLength + 1);
		unframedBytes.set(bytes);
		unframedBytes[bytes.byteLength] = 0x0a;
		try {
			const candidate = decodeSessionLog(sessionId, unframedBytes);
			timestamps = pendingAppendTimestamps(candidate, intent, sessionId);
		} catch (error) {
			if (
				error instanceof SessionLogError &&
				error.code === "session_operation_conflict"
			) {
				throw error;
			}
		}
		return { ...timestamps, state };
	};

	const trackIndeterminateAttachmentLease = async (
		sessionId: SessionId,
		operationId: string,
		lease: AttachmentExternalizationLease
	): Promise<void> => {
		const leases = pendingAttachmentLeases.get(sessionId) ?? new Set();
		leases.add({ operationId, lease });
		pendingAttachmentLeases.set(sessionId, leases);
		// A concurrent authoritative read may have reconciled before this result
		// was registered. Re-read once so a settled operation cannot strand a pin.
		try {
			await (await projected.open(sessionId)).atHeadState();
		} catch {
			// The retained lease remains available to a later authoritative read.
		}
	};

	const ensureReceipt = async (
		sessionId: SessionId,
		entry: SessionLogEntry
	): Promise<void> => {
		try {
			await sessionLog.ensureReceipt(sessionId, entry);
		} catch (error) {
			if (
				error instanceof SessionLogError &&
				error.code === "session_operation_conflict"
			) {
				throw error;
			}
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
	};

	const projectCommittedEntry = (
		sessionId: SessionId,
		entry: SessionLogEntry,
		state: SessionLogState,
		cursorBefore: SessionProjectionCursor | undefined
	): void => {
		try {
			projection.projectEntries(sessionId, [entry], state, cursorBefore);
		} catch (error) {
			if (
				sessionProjectionMatchesState(
					projection.getCursor(sessionId),
					state,
					projection.getMaintenanceState().generation
				)
			) {
				return;
			}
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
	};

	const persistReceiptAndProjection = async (
		sessionId: SessionId,
		entry: SessionLogEntry,
		state: SessionLogState,
		cursorBefore: SessionProjectionCursor | undefined,
		intent: SessionWriteIntent
	): Promise<void> => {
		try {
			await ensureReceipt(sessionId, entry);
			if (entry.envelope.type !== "session.deleted") {
				await sessionLog.clearWriteIntent(intent);
			}
			projectCommittedEntry(sessionId, entry, state, cursorBefore);
		} catch (error) {
			if (error instanceof SessionWriteOutcomeError) {
				throw error;
			}
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
	};

	const reconcileCommittedPendingAppend = async (
		sessionId: SessionId,
		logPath: string,
		bytes: Uint8Array,
		intent: SessionWriteIntent,
		entry: SessionLogEntry
	): Promise<SessionLogEntry> => {
		if (
			entry.envelope.sequence !== intent.sequence ||
			entry.startOffset !== intent.expectedOffset
		) {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Committed Session entry does not match its pending write boundary.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		await sessionLog.syncPrefix(logPath, bytes, sessionId);
		try {
			await sessionLog.ensureReceipt(sessionId, entry);
			if (intent.type !== "session.deleted") {
				await sessionLog.clearWriteIntent(intent);
			}
		} catch (error) {
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
		return entry;
	};

	const assertPendingAppendAtLogHead = (
		sessionId: SessionId,
		intent: SessionWriteIntent,
		bytes: Uint8Array,
		state: SessionLogState
	): void => {
		if (
			state.nextSequence === intent.sequence &&
			bytes.byteLength === intent.expectedOffset
		) {
			return;
		}
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session log does not match the pending write boundary.",
			{
				offset: intent.expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	};

	const reconcilePendingAppend = async (
		sessionId: SessionId,
		logPath: string,
		write: SessionWrite,
		intent: SessionWriteIntent
	): Promise<SessionLogEntry | undefined> => {
		assertSameSessionWriteIntent(
			intent,
			{
				operationDigest: sessionLogOperationDigest(write.type, write.payload),
				operationId: write.operationId,
				type: write.type,
			},
			sessionId
		);
		let loaded: Readonly<{ bytes: Uint8Array; state: SessionLogState }>;
		try {
			loaded = await sessionLog.read(sessionId);
		} catch (error) {
			if (
				!(error instanceof SessionLogError) ||
				error.code !== "session_log_truncated"
			) {
				throw error;
			}
			await sessionLog.quarantinePendingAppend(sessionId, logPath, intent);
			return;
		}
		const { bytes, state } = loaded;
		const previous = findOperation(state, write, sessionId);
		if (previous !== undefined) {
			return reconcileCommittedPendingAppend(
				sessionId,
				logPath,
				bytes,
				intent,
				previous
			);
		}
		assertPendingAppendAtLogHead(sessionId, intent, bytes, state);
		await sessionLog.syncPrefix(logPath, bytes, sessionId);
	};

	const committedOperation = async (
		sessionId: SessionId,
		write: SessionWrite,
		state: SessionLogState,
		intent?: SessionWriteIntent
	): Promise<CommittedLogEntry | undefined> => {
		const entry = findOperation(state, write, sessionId);
		if (entry === undefined) {
			return;
		}
		try {
			await ensureReceipt(sessionId, entry);
			if (intent !== undefined && intent.type !== "session.deleted") {
				await sessionLog.clearWriteIntent(intent);
			}
		} catch (error) {
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
		return { createdNew: false, entry, receiptBlocked: false, state };
	};

	const stateAfterProjectionCatchup = async (
		sessionId: SessionId,
		write: SessionWrite,
		pendingIntent: SessionWriteIntent | undefined
	): Promise<SessionLogState> => {
		try {
			return (await (await projected.open(sessionId)).atHeadState()).state;
		} catch (error) {
			if (
				pendingIntent !== undefined ||
				!(
					isCommittedProjectionBlocked(error) ||
					(error instanceof SessionLogError &&
						error.code === "session_projection_blocked")
				)
			) {
				throw error;
			}
			let state: SessionLogState;
			try {
				({ state } = await sessionLog.read(sessionId));
			} catch {
				throw error;
			}
			const committed = await committedOperation(sessionId, write, state);
			if (committed !== undefined) {
				throw new SessionWriteOutcomeError(
					toReceipt(committed.entry, "blocked"),
					error
				);
			}
			// JSONL is authoritative; a blocked read projection must not discard a
			// separate completed side effect that still needs its durable checkpoint.
			return state;
		}
	};

	const projectRecoveredOperation = async (
		sessionId: SessionId,
		entry: SessionLogEntry
	): Promise<CommittedLogEntry> => {
		if (entry.envelope.type === "session.deleted") {
			const { state } = await sessionLog.read(sessionId);
			const matchingEntry = state.entries.find(
				({ envelope }) => envelope.entryHash === entry.envelope.entryHash
			);
			if (matchingEntry === undefined) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"Recovered Session deletion no longer matches its authoritative log."
				);
			}
			return {
				createdNew: false,
				entry: matchingEntry,
				receiptBlocked: false,
				state,
			};
		}
		try {
			return {
				createdNew: false,
				entry,
				receiptBlocked: false,
				state: (await (await projected.open(sessionId)).atHeadState()).state,
			};
		} catch (error) {
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
	};

	const appendNewOperation = async (
		sessionId: SessionId,
		logPath: string,
		write: SessionWrite,
		bytes: Uint8Array,
		state: SessionLogState,
		cursorBefore: SessionProjectionCursor | undefined,
		pendingIntent: SessionWriteIntent | undefined,
		project = true
	): Promise<CommittedLogEntry> => {
		const payloadTimestamp = Reflect.get(write.payload, "createdAt");
		const timestamp =
			pendingIntent?.timestamp ??
			write.envelopeTimestamp ??
			(isCanonicalTimestamp(payloadTimestamp)
				? payloadTimestamp
				: new Date().toISOString());
		const intent =
			pendingIntent === undefined
				? {
						expectedOffset: bytes.byteLength,
						operationDigest: sessionLogOperationDigest(
							write.type,
							write.payload
						),
						operationId: write.operationId,
						sequence: state.nextSequence,
						sessionId,
						timestamp,
						type: write.type,
						...omitUndefined({
							historyReferences: sessionHistoryReferencesForWrite(write),
						}),
					}
				: {
						...pendingIntent,
						timestamp,
						...omitUndefined({
							historyReferences:
								sessionHistoryReferencesForWrite(write) ??
								pendingIntent.historyReferences,
						}),
					};
		if (
			intent.expectedOffset !== bytes.byteLength ||
			intent.sequence !== state.nextSequence
		) {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Session log head does not match its pending write marker.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		const envelope = createSessionLogEvent({
			operationId: write.operationId,
			payload: write.payload,
			previousHash: state.lastHash,
			sequence: state.nextSequence,
			sessionId,
			timestamp: intent.timestamp,
			type: write.type,
		});
		if (pendingIntent?.timestamp === undefined) {
			await sessionLog.writeIntent(intent);
		}
		await sessionLog.appendBytes(
			sessionId,
			logPath,
			encodeSessionLogLine(envelope),
			intent
		);
		const verified = await sessionLog.verifyAppended(
			sessionId,
			logPath,
			envelope,
			intent
		);
		if (project) {
			await persistReceiptAndProjection(
				sessionId,
				verified.entry,
				verified.state,
				cursorBefore,
				intent
			);
		} else {
			await ensureReceipt(sessionId, verified.entry);
			if (intent.type !== "session.deleted") {
				await sessionLog.clearWriteIntent(intent);
			}
		}
		return {
			createdNew: false,
			entry: verified.entry,
			receiptBlocked: false,
			state: verified.state,
		};
	};

	const appendResetDeletion = async (
		sessionId: SessionId
	): Promise<Readonly<{ logId: string; receipt: SessionDeletionReceipt }>> => {
		const operationId = sessionDeletionOperationId(sessionId);
		const write: SessionWrite = {
			operationId,
			payload: {},
			type: "session.deleted",
		};
		return sessionLog.runSerial(sessionId, async () => {
			const logPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				sessionId
			);
			const pendingIntent = await sessionLog.readWriteIntent(sessionId);
			if (pendingIntent !== undefined) {
				const recovered = await reconcilePendingAppend(
					sessionId,
					logPath,
					write,
					pendingIntent
				);
				if (recovered !== undefined) {
					const { state } = await sessionLog.read(sessionId);
					return {
						logId: state.logId,
						receipt: deletionReceiptFromEntry(recovered),
					};
				}
			}
			const { bytes, state } = await sessionLog.read(sessionId);
			const previous = findOperation(state, write, sessionId);
			if (previous !== undefined) {
				await ensureReceipt(sessionId, previous);
				return {
					logId: state.logId,
					receipt: deletionReceiptFromEntry(previous),
				};
			}
			const appended = await appendNewOperation(
				sessionId,
				logPath,
				write,
				bytes,
				state,
				undefined,
				pendingIntent,
				false
			);
			return {
				logId: appended.state.logId,
				receipt: deletionReceiptFromEntry(appended.entry),
			};
		});
	};

	const activeHistoryLeafFromState = (
		state: SessionLogState
	): SessionHistoryEntryId | null =>
		state.entries.reduce<SessionHistoryEntryId | null>(
			(activeLeafId, { envelope }) =>
				envelope.type === "session.created" ||
				envelope.type === "session.history-navigated" ||
				isSessionHistoryEntryEventType(envelope.type)
					? sessionHistoryEntryIdOrNullFromPayload(
							envelope.payload.activeLeafId
						)
					: activeLeafId,
			null
		);

	const historyEntryExists = (
		state: SessionLogState,
		targetEntryId: SessionHistoryEntryId | null
	): boolean => {
		if (targetEntryId === null) {
			return true;
		}
		const parents = new Map<
			SessionHistoryEntryId,
			SessionHistoryEntryId | null
		>();
		for (const { envelope } of state.entries) {
			if (
				envelope.type === "session.created" &&
				typeof envelope.payload.initialHistoryEntryId === "string"
			) {
				parents.set(
					sessionHistoryEntryIdFromPayload(
						envelope.payload.initialHistoryEntryId
					),
					null
				);
			} else if (isSessionHistoryEntryEventType(envelope.type)) {
				parents.set(
					sessionHistoryEntryIdFromPayload(envelope.payload.historyEntryId),
					sessionHistoryEntryIdOrNullFromPayload(envelope.payload.parentEntryId)
				);
			}
		}
		return parents.has(targetEntryId);
	};

	const withSessionHistoryReferences = (
		sessionId: SessionId,
		state: SessionLogState,
		write: SessionWrite
	): SessionWrite => {
		if (!isSessionHistoryWrite(write)) {
			return write;
		}
		const previous = state.entries.find(
			({ envelope }) => envelope.operationId === write.operationId
		);
		if (previous?.envelope.type === write.type) {
			return {
				...write,
				payload: {
					...write.payload,
					activeLeafId: previous.envelope.payload.activeLeafId,
					historyEntryId: previous.envelope.payload.historyEntryId,
					parentEntryId: previous.envelope.payload.parentEntryId,
				},
			};
		}
		const activeLeafId = activeHistoryLeafFromState(state);
		const historyEntryId =
			write.type === "record.committed"
				? sessionHistoryEntryIdForRecord(
						sessionId,
						(write.payload.record as SessionRecord).id
					)
				: sessionHistoryEntryIdForOperation(sessionId, write.operationId);
		return {
			...write,
			payload: {
				...write.payload,
				activeLeafId: historyEntryId,
				historyEntryId,
				parentEntryId: activeLeafId,
			},
		};
	};

	const readLogForHistoryWrite = async (
		sessionId: SessionId
	): Promise<SessionLogState> => (await sessionLog.read(sessionId)).state;

	const prepareSessionHistoryNavigationWrite = (
		sessionId: SessionId,
		state: SessionLogState,
		write: SessionWrite
	): SessionWrite => {
		if (write.type !== "session.history-navigated") {
			return write;
		}
		const previous = state.entries.find(
			({ envelope }) => envelope.operationId === write.operationId
		);
		if (
			previous?.envelope.type === write.type &&
			previous.envelope.payload.activeLeafId === write.payload.activeLeafId
		) {
			return {
				...write,
				payload: {
					...write.payload,
					previousActiveLeafId: previous.envelope.payload.previousActiveLeafId,
				},
			};
		}
		const activeLeafId = activeHistoryLeafFromState(state);
		const targetEntryId = write.payload.activeLeafId;
		let parsedTargetEntryId: SessionHistoryEntryId | null | undefined;
		if (targetEntryId === null) {
			parsedTargetEntryId = null;
		} else if (
			typeof targetEntryId === "string" &&
			isValidSessionHistoryEntryId(targetEntryId)
		) {
			parsedTargetEntryId = targetEntryId;
		} else {
			parsedTargetEntryId = undefined;
		}
		if (
			write.payload.previousActiveLeafId !== activeLeafId ||
			parsedTargetEntryId === undefined ||
			!historyEntryExists(state, parsedTargetEntryId)
		) {
			throw new SessionLogError(
				"session_operation_conflict",
				sessionId,
				"Navigation target must be an existing history entry or the root.",
				{ operationId: write.operationId }
			);
		}
		return write;
	};

	// Check against the log snapshot that will also determine the appended parent.
	const assertExpectedPluginHistoryGeneration = (
		sessionId: SessionId,
		state: SessionLogState,
		operationId: string,
		expected: ExpectedPluginHistoryGeneration | undefined
	): void => {
		if (expected === undefined) {
			return;
		}
		const historyTree = buildSessionHistoryTreeEntries(
			state,
			sessionId,
			state.nextSequence - 1
		);
		if (historyTree.historyGeneration !== expected.generation) {
			throw new SessionLogError(
				"session_operation_conflict",
				sessionId,
				expected.message,
				{ operationId }
			);
		}
	};
	const recordWriteWithHistory = async (
		sessionId: SessionId,
		write: SessionWrite,
		pendingIntent: SessionWriteIntent | undefined,
		expectedGeneration?: ExpectedPluginHistoryGeneration
	): Promise<SessionWrite> => {
		if (
			!isSessionHistoryWrite(write) &&
			write.type !== "session.history-navigated"
		) {
			return write;
		}
		if (pendingIntent !== undefined) {
			if (
				pendingIntent.operationId !== write.operationId ||
				pendingIntent.type !== write.type ||
				write.type === "session.history-navigated"
			) {
				return write;
			}
			if (pendingIntent.historyReferences !== undefined) {
				return {
					...write,
					payload: { ...write.payload, ...pendingIntent.historyReferences },
				};
			}
			const state = (await stateForPendingAppend(sessionId, pendingIntent))
				.state;
			assertExpectedPluginHistoryGeneration(
				sessionId,
				state,
				write.operationId,
				expectedGeneration
			);
			return withSessionHistoryReferences(sessionId, state, write);
		}
		const state = await readLogForHistoryWrite(sessionId);
		assertExpectedPluginHistoryGeneration(
			sessionId,
			state,
			write.operationId,
			expectedGeneration
		);
		if (write.type === "session.history-navigated") {
			return prepareSessionHistoryNavigationWrite(sessionId, state, write);
		}
		return withSessionHistoryReferences(sessionId, state, write);
	};

	const append = async (
		sessionId: SessionId,
		write: SessionWrite,
		expectedGeneration?: ExpectedPluginHistoryGeneration
	): Promise<CommittedLogEntry> =>
		sessionLog.runSerial(sessionId, async () => {
			const logPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				sessionId
			);
			const pendingIntent = await sessionLog.readWriteIntent(sessionId);
			const preparedWrite = await recordWriteWithHistory(
				sessionId,
				write,
				pendingIntent,
				expectedGeneration
			);
			if (pendingIntent !== undefined) {
				const recovered = await reconcilePendingAppend(
					sessionId,
					logPath,
					preparedWrite,
					pendingIntent
				);
				if (recovered !== undefined) {
					return projectRecoveredOperation(sessionId, recovered);
				}
			}

			const stateBefore = await stateAfterProjectionCatchup(
				sessionId,
				preparedWrite,
				pendingIntent
			);
			const cursorBefore = projection.getCursor(sessionId);
			const { bytes, state } = await sessionLog.read(sessionId);
			if (state.lastHash !== stateBefore.lastHash) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"Session log changed after projection catch-up."
				);
			}
			const previous = await committedOperation(
				sessionId,
				preparedWrite,
				state,
				pendingIntent
			);
			if (previous !== undefined) {
				return previous;
			}
			assertExpectedPluginHistoryGeneration(
				sessionId,
				state,
				write.operationId,
				expectedGeneration
			);
			return appendNewOperation(
				sessionId,
				logPath,
				preparedWrite,
				bytes,
				state,
				cursorBefore,
				pendingIntent
			);
		});

	const withTemporaryWriter = async <Result>(
		sessionId: SessionId,
		operation: () => Promise<Result>,
		onWriterReleaseFailure?: (error: unknown) => Error,
		reuseHeldWriter = true,
		onOperationEnqueued?: () => void
	): Promise<Result> => {
		const key = await lockKey(logRoot, sessionId);
		const queuedOperation = sessionLog.runWriter(sessionId, async () => {
			const writer =
				reuseHeldWriter && heldWriterKeys.has(key)
					? undefined
					: await acquireSessionWriterLock(logRoot, sessionId);
			const releaseWriter = async (): Promise<void> => {
				try {
					await writer?.release();
				} catch (error) {
					if (onWriterReleaseFailure !== undefined) {
						throw onWriterReleaseFailure(error);
					}
					throw error;
				}
			};
			let result: Result;
			try {
				result = await operation();
			} catch (error) {
				await releaseWriter();
				throw error;
			}
			await releaseWriter();
			return result;
		});
		// queue.run stores the key's tail synchronously before returning.
		onOperationEnqueued?.();
		return queuedOperation;
	};

	const acquireWriter = async (
		sessionId: SessionId,
		options?: SessionWriterLockOptions
	): Promise<SessionWriterLock> => {
		await projected.open(sessionId);
		const writer = await acquireSessionWriterLock(logRoot, sessionId, options);
		const key = await lockKey(logRoot, sessionId);
		heldWriterKeys.add(key);
		let released = false;
		return {
			release: async () => {
				if (released) {
					return;
				}
				released = true;
				heldWriterKeys.delete(key);
				await writer.release();
			},
		};
	};

	const readSessionBundleExportSnapshot = async (
		sessionId: SessionId,
		scope: SessionBundleExportScope,
		signal?: AbortSignal
	) => {
		throwIfAborted(signal, "Session bundle export was cancelled.");
		await projected.open(sessionId);
		await assertSessionWritable(sessionId);
		const pendingIntent = await sessionLog.readWriteIntent(sessionId);
		if (pendingIntent !== undefined) {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Session export is blocked until the indeterminate write is reconciled.",
				{
					offset: pendingIntent.expectedOffset,
					operationId: pendingIntent.operationId,
					sequence: pendingIntent.sequence,
				}
			);
		}
		const canonicalRoot = await fs.realpath(logRoot);
		const logPath = resolveSessionLogFilePath(canonicalRoot, sessionId);
		let bytes: Uint8Array;
		let state: SessionLogState;
		try {
			({ bytes, state } = await sessionLog.read(sessionId));
		} catch (error) {
			if (isCode(error, "ENOENT")) {
				throw new SessionLogError(
					"session_not_found",
					sessionId,
					"Session not found.",
					{ cause: error }
				);
			}
			throw error;
		}
		const checked = validateSessionBundleLog(sessionId, bytes, "source");
		const generation = (await projected.open(sessionId)).generation;
		const cursor = projection.getCursor(sessionId);
		(await projected.open(sessionId)).assertCursorWithinLog(cursor, state);
		if (!sessionProjectionMatchesState(cursor, state, generation)) {
			throw new SessionLogError(
				"session_projection_blocked",
				sessionId,
				"Session projection is not at the verified JSONL cut; retry after projection recovery."
			);
		}
		await projectionStore.getSession(sessionId);
		await syncAndVerifyLogPrefix(
			logPath,
			bytes,
			sessionId,
			fileIo,
			state.nextSequence - 1
		);
		throwIfAborted(signal, "Session bundle export was cancelled.");
		const currentBytes = await Bun.file(logPath).bytes();
		const changedOffset = firstDifferentByteOffset(bytes, currentBytes);
		if (changedOffset !== undefined) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				"Session log changed while its export cut was being synced.",
				{ offset: changedOffset, sequence: state.nextSequence - 1 }
			);
		}
		const branchLog =
			scope === "branch"
				? createSessionBundleBranchLog(sessionId, state)
				: undefined;
		const exportSessionId = branchLog?.sessionId ?? sessionId;
		const exportBytes = branchLog?.logBytes ?? bytes;
		const exportChecked =
			branchLog === undefined
				? checked
				: validateSessionBundleLog(exportSessionId, exportBytes, "source");
		const exportState = exportChecked.state;
		const exportAttachments = exportChecked.attachments;
		const attachmentStore = projectionStore.attachmentStore;
		if (exportAttachments.length > 0 && attachmentStore === undefined) {
			throw new SessionBundleValidationError(
				"Session attachment storage is unavailable for bundle export."
			);
		}
		return {
			attachments: exportAttachments,
			cut: {
				hash: exportState.lastHash,
				sequence: exportState.nextSequence - 1,
			},
			scope,
			...omitUndefined({
				resolveAttachment: attachmentStore?.resolve,
				source: branchLog?.source,
			}),
			logBytes: exportBytes,
			logId: exportState.logId,
			sessionId: exportSessionId,
		};
	};

	const withSessionBundleExport = async <Result>(
		sessionId: SessionId,
		operation: (source: PreparedSessionBundleExport) => Promise<Result>,
		options: Readonly<{
			existingHostWriter: boolean;
			scope: SessionBundleExportScope;
			signal?: AbortSignal;
		}>
	): Promise<Result> =>
		withTemporaryWriter(
			sessionId,
			async () => {
				throwIfAborted(options.signal, "Session bundle export was cancelled.");
				const source = await readSessionBundleExportSnapshot(
					sessionId,
					options.scope,
					options.signal
				);
				const attachmentStore = projectionStore.attachmentStore;
				const attachmentIds = [
					...new Set(
						source.attachments.map(({ attachmentId }) => attachmentId)
					),
				];
				let retainedAttachmentIds: string[] = [];
				const releasePins = async (): Promise<void> => {
					if (
						retainedAttachmentIds.length === 0 ||
						attachmentStore === undefined
					) {
						return;
					}
					let firstError: unknown;
					for (const attachmentId of retainedAttachmentIds) {
						try {
							await attachmentStore.release([attachmentId]);
						} catch (error) {
							firstError ??= error;
						}
					}
					if (firstError !== undefined) {
						throw firstError;
					}
				};
				if (attachmentIds.length > 0 && attachmentStore !== undefined) {
					await attachmentStore.retain(attachmentIds);
					retainedAttachmentIds = attachmentIds;
				}
				const outcome = await (async () => {
					throwIfAborted(
						options.signal,
						"Session bundle export was cancelled."
					);
					return await operation(source);
				})().then(
					(value) => ({ kind: "success" as const, value }),
					(error: unknown) => ({ kind: "failure" as const, error })
				);
				try {
					await releasePins();
				} catch (error) {
					throw new SessionBundleExportCleanupError(error);
				}
				if (outcome.kind === "failure") {
					throw outcome.error;
				}
				return outcome.value;
			},
			(error) => new SessionBundleExportCleanupError(error),
			options.existingHostWriter
		);

	const sessionBundleImportIdentity = (
		prepared: PreparedSessionBundleImport
	): string =>
		digestBytes(
			new TextEncoder().encode(
				encodeCanonicalSessionJson({
					attachments: prepared.bundle.manifest.attachments
						.map(({ attachmentId, byteLength, sha256 }) => ({
							attachmentId,
							byteLength,
							sha256,
						}))
						.sort((left, right) =>
							left.attachmentId.localeCompare(right.attachmentId)
						),
					cut: prepared.bundle.cut,
					logId: prepared.bundle.session.logId,
					logSha256: prepared.bundle.manifest.sessionFile.sha256,
					sessionId: prepared.bundle.session.id,
				})
			)
		);

	const inspectSessionBundleImportTarget = async (
		sessionId: SessionId
	): Promise<
		| Readonly<{
				bytes: Uint8Array;
				state: SessionLogState;
				targetPath: string;
		  }>
		| undefined
	> => {
		const root = await fs.realpath(logRoot);
		const targetPath = resolveSessionLogFilePath(root, sessionId);
		try {
			const logInfo = await fs.lstat(targetPath);
			if (!logInfo.isFile() || logInfo.isSymbolicLink()) {
				throw new SessionBundleImportConflictError(
					"The target Session log is not a regular file."
				);
			}
			const existing = await readLog(targetPath, sessionId);
			return { ...existing, targetPath };
		} catch (error) {
			if (isCode(error, "ENOENT")) {
				return;
			}
			throw error;
		}
	};

	const assertImportedBundleAttachmentsAvailable = async (
		prepared: PreparedSessionBundleImport,
		signal?: AbortSignal
	): Promise<void> => {
		if (prepared.attachments.length === 0) {
			return;
		}
		const attachmentStore = projectionStore.attachmentStore;
		if (attachmentStore === undefined) {
			throw new SessionBundleImportConflictError(
				"The existing Session attachment store is unavailable."
			);
		}
		const checkedIds = new Set<string>();
		for (const reference of prepared.attachments) {
			if (checkedIds.has(reference.attachmentId)) {
				continue;
			}
			checkedIds.add(reference.attachmentId);
			const result = await attachmentStore.resolve(reference, signal);
			if (result.availability !== "available") {
				throw new SessionBundleImportConflictError(
					`Existing Session attachment ${reference.attachmentId} is missing or corrupt.`
				);
			}
		}
	};

	type SessionBundleImportTarget = Readonly<{
		bytes: Uint8Array;
		state: SessionLogState;
		targetPath: string;
	}>;
	type SessionImportPublicationState = { logPublished: boolean };

	const assertSessionImportMarkerMatchesBundle = (
		marker: SessionImportActivationMarker,
		prepared: PreparedSessionBundleImport,
		identity: string
	): void => {
		if (
			marker.bundleIdentity !== identity ||
			marker.logId !== prepared.bundle.session.logId ||
			marker.cutHash !== prepared.bundle.cut.hash ||
			marker.cutSequence !== prepared.bundle.cut.sequence ||
			marker.workspaceId !== projection.workspaceId
		) {
			throw new SessionBundleImportConflictError(
				"A durable Session import activation marker conflicts with this bundle or workspace."
			);
		}
	};

	const assertSessionImportTargetMatchesBundle = (
		target: SessionBundleImportTarget,
		prepared: PreparedSessionBundleImport,
		identity: string
	): void => {
		const cutEntry = target.state.entries.find(
			({ envelope }) => envelope.sequence === prepared.bundle.cut.sequence
		);
		const hasImportedLogPrefix =
			target.bytes.byteLength >= prepared.logBytes.byteLength &&
			equalBytes(
				target.bytes.subarray(0, prepared.logBytes.byteLength),
				prepared.logBytes
			);
		if (
			!hasImportedLogPrefix ||
			target.state.logId !== prepared.bundle.session.logId ||
			cutEntry?.envelope.entryHash !== prepared.bundle.cut.hash
		) {
			throw new SessionBundleImportConflictError(
				"The target Session ID has different authoritative log content."
			);
		}
		if (target.bytes.byteLength === prepared.logBytes.byteLength) {
			return;
		}
		const hasMatchingActivation = target.state.entries.some(
			({ envelope }) =>
				envelope.type === "session.activation-confirmed" &&
				envelope.sequence > prepared.bundle.cut.sequence &&
				envelope.payload.bundleIdentity === identity
		);
		if (!hasMatchingActivation) {
			throw new SessionBundleImportConflictError(
				"The target Session ID has an unrelated extension after the imported log."
			);
		}
	};

	const assertSessionImportTargetAvailable = async (
		sessionId: SessionId
	): Promise<void> => {
		if ((await sessionLog.readDeletedMarker(sessionId)) !== undefined) {
			throw new SessionBundleImportConflictError(
				"A deleted Session ID cannot be reimported."
			);
		}
		if (projection.isBoundToAnotherWorkspace(sessionId)) {
			throw new SessionBundleImportConflictError(
				"The Session ID is already bound to another local workspace."
			);
		}
	};

	const recoverExistingSessionImportUnderGate = async (
		prepared: PreparedSessionBundleImport,
		identity: string
	): Promise<SessionBundleImportResult> => {
		const sessionId = prepared.bundle.session.id;
		await assertSessionImportTargetAvailable(sessionId);
		const marker = await readSessionImportActivationMarker(logRoot, sessionId);
		if (marker !== undefined) {
			assertSessionImportMarkerMatchesBundle(marker, prepared, identity);
		}
		if (marker === undefined) {
			throw new SessionBundleImportConflictError(
				"The existing Session is not covered by a durable import activation marker."
			);
		}
		const target = await inspectSessionBundleImportTarget(sessionId);
		if (target === undefined) {
			throw new SessionBundleImportConflictError(
				"The target Session disappeared while its import was being recovered."
			);
		}
		assertSessionImportTargetMatchesBundle(target, prepared, identity);
		projection.bindSessionToWorkspace(sessionId);
		await (await projected.open(sessionId)).atHead();
		return { activationPending: true, sessionId, status: "unchanged" };
	};

	const recoverExistingSessionImport = async (
		prepared: PreparedSessionBundleImport,
		options: Readonly<{ signal?: AbortSignal }>,
		identity: string
	): Promise<SessionBundleImportResult | undefined> => {
		const sessionId = prepared.bundle.session.id;
		await assertSessionImportTargetAvailable(sessionId);
		const marker = await readSessionImportActivationMarker(logRoot, sessionId);
		if (marker !== undefined) {
			assertSessionImportMarkerMatchesBundle(marker, prepared, identity);
		}
		const target = await inspectSessionBundleImportTarget(sessionId);
		if (target === undefined) {
			return;
		}
		assertSessionImportTargetMatchesBundle(target, prepared, identity);
		await assertImportedBundleAttachmentsAvailable(prepared, options.signal);
		if (projection.isBoundToWorkspace(sessionId)) {
			await (await projected.open(sessionId)).atHead();
			return {
				activationPending: marker !== undefined,
				sessionId,
				status: "unchanged",
			};
		}
		if (marker === undefined) {
			throw new SessionBundleImportConflictError(
				"An existing Session without a local import marker cannot be rebound."
			);
		}
		return await withTemporaryWriter(
			sessionId,
			async () =>
				await withSessionCatalogLifecycleGate(
					logRoot,
					async () =>
						await recoverExistingSessionImportUnderGate(prepared, identity)
				),
			undefined,
			false
		);
	};

	const ingestSessionBundleAttachments = async (
		prepared: PreparedSessionBundleImport,
		options: Readonly<{ signal?: AbortSignal }>
	): Promise<AttachmentIngestLease[]> => {
		const attachmentStore = projectionStore.attachmentStore;
		if (prepared.attachments.length > 0 && attachmentStore === undefined) {
			throw new SessionBundleValidationError(
				"Session attachment storage is unavailable for bundle import."
			);
		}
		const attachmentEntries = new Map(
			prepared.bundle.manifest.attachments.map((attachment) => [
				attachment.attachmentId,
				attachment,
			])
		);
		const leases: AttachmentIngestLease[] = [];
		const ingestedIds = new Set<string>();
		try {
			for (const reference of prepared.attachments) {
				throwIfAborted(options.signal, "Session bundle import was cancelled.");
				if (ingestedIds.has(reference.attachmentId)) {
					continue;
				}
				ingestedIds.add(reference.attachmentId);
				const entry = attachmentEntries.get(reference.attachmentId);
				if (entry === undefined || attachmentStore === undefined) {
					throw new SessionBundleValidationError(
						"Session bundle is missing a referenced attachment."
					);
				}
				const bytes = await prepared.readAttachment(reference.attachmentId);
				const lease = await attachmentStore.ingest(
					{
						bytes,
						filename: entry.filename,
						mediaType: entry.mediaType,
					},
					options.signal
				);
				leases.push(lease);
				if (
					lease.reference.attachmentId !== reference.attachmentId ||
					lease.reference.byteLength !== reference.byteLength ||
					lease.reference.filename !== reference.filename ||
					lease.reference.height !== reference.height ||
					lease.reference.mediaType !== reference.mediaType ||
					lease.reference.width !== reference.width
				) {
					throw new SessionBundleValidationError(
						`Imported attachment ${reference.attachmentId} does not match its log reference.`
					);
				}
			}
		} catch (error) {
			await Promise.allSettled(
				leases.map(async (lease) => await lease.release())
			);
			throw error;
		}
		return leases;
	};

	const publishStagedSessionImportLog = async (
		prepared: PreparedSessionBundleImport,
		options: Readonly<{ fileSystem?: SessionBundleImportFileSystem }>,
		staged: StagedSessionLog,
		publication: SessionImportPublicationState
	): Promise<void> => {
		const sessionId = prepared.bundle.session.id;
		const targetPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
		);
		await options.fileSystem?.beforePublish?.(staged.filePath, targetPath);
		try {
			await sessionLog.publishStaged(staged, targetPath, () => {
				publication.logPublished = true;
			});
		} catch (error) {
			if (isCode(error, "EEXIST")) {
				throw new SessionBundleImportConflictError(
					"The target Session ID was published concurrently."
				);
			}
			throw error;
		}
		try {
			await options.fileSystem?.afterPublish?.(targetPath);
			await (await projected.open(sessionId)).atHead();
		} catch (error) {
			throw new SessionBundleImportIndeterminateError(
				"Session bundle log was published, but import recovery or projection did not complete.",
				{ cause: error }
			);
		}
	};

	const publishSessionImportUnderGate = async (
		prepared: PreparedSessionBundleImport,
		options: Readonly<{
			fileSystem?: SessionBundleImportFileSystem;
			signal?: AbortSignal;
		}>,
		staged: StagedSessionLog,
		identity: string,
		publication: SessionImportPublicationState
	): Promise<SessionBundleImportResult> => {
		throwIfAborted(options.signal, "Session bundle import was cancelled.");
		const sessionId = prepared.bundle.session.id;
		await assertSessionImportTargetAvailable(sessionId);
		const marker = await readSessionImportActivationMarker(logRoot, sessionId);
		if (marker !== undefined) {
			assertSessionImportMarkerMatchesBundle(marker, prepared, identity);
		}
		const current = await inspectSessionBundleImportTarget(sessionId);
		if (current !== undefined) {
			assertSessionImportTargetMatchesBundle(current, prepared, identity);
			if (marker === undefined) {
				if (!projection.isBoundToWorkspace(sessionId)) {
					throw new SessionBundleImportConflictError(
						"An existing Session without an import marker cannot be rebound."
					);
				}
				await assertImportedBundleAttachmentsAvailable(
					prepared,
					options.signal
				);
				await (await projected.open(sessionId)).atHead();
				return { activationPending: false, sessionId, status: "unchanged" };
			}
			projection.bindSessionToWorkspace(sessionId);
			await (await projected.open(sessionId)).atHead();
			return { activationPending: true, sessionId, status: "unchanged" };
		}
		projection.bindSessionToWorkspace(sessionId);
		if (marker === undefined) {
			await writeSessionImportActivationMarker(
				logRoot,
				{
					activationOperationId: `import-activate-${randomUUIDv7()}`,
					bundleIdentity: identity,
					cutHash: prepared.bundle.cut.hash,
					cutSequence: prepared.bundle.cut.sequence,
					logId: prepared.bundle.session.logId,
					sessionId,
					version: 1,
					workspaceId: projection.workspaceId,
				},
				fileIo
			);
		}
		await options.fileSystem?.afterActivationMarker?.();
		throwIfAborted(options.signal, "Session bundle import was cancelled.");
		await publishStagedSessionImportLog(prepared, options, staged, publication);
		return { activationPending: true, sessionId, status: "imported" };
	};

	const publishStagedSessionImport = async (
		prepared: PreparedSessionBundleImport,
		options: Readonly<{
			fileSystem?: SessionBundleImportFileSystem;
			signal?: AbortSignal;
		}>,
		staged: StagedSessionLog,
		identity: string,
		publication: SessionImportPublicationState
	): Promise<SessionBundleImportResult> => {
		const sessionId = prepared.bundle.session.id;
		return await withTemporaryWriter(
			sessionId,
			async () =>
				await withSessionCatalogLifecycleGate(
					logRoot,
					async () =>
						await publishSessionImportUnderGate(
							prepared,
							options,
							staged,
							identity,
							publication
						)
				),
			undefined,
			false
		);
	};

	const releaseSessionImportResources = async (
		leases: readonly AttachmentIngestLease[],
		staged: StagedSessionLog | undefined,
		publication: SessionImportPublicationState
	): Promise<unknown | undefined> => {
		let cleanupFailure: unknown;
		for (const lease of leases) {
			try {
				await lease.release();
			} catch (error) {
				cleanupFailure ??= error;
			}
		}
		if (staged !== undefined && !publication.logPublished) {
			try {
				await fs.rm(staged.filePath, { force: true });
				await syncDirectoryAfterDurablePublication(staged.root, fileIo);
			} catch (error) {
				cleanupFailure ??= error;
			}
		}
		return cleanupFailure;
	};

	const importNewSessionBundle = async (
		prepared: PreparedSessionBundleImport,
		options: Readonly<{
			fileSystem?: SessionBundleImportFileSystem;
			signal?: AbortSignal;
		}>,
		identity: string
	): Promise<SessionBundleImportResult> => {
		const leases = await ingestSessionBundleAttachments(prepared, options);
		const publication: SessionImportPublicationState = { logPublished: false };
		let staged: StagedSessionLog | undefined;
		let result: SessionBundleImportResult | undefined;
		let failure: unknown;
		try {
			await options.fileSystem?.afterAttachmentsStaged?.();
			throwIfAborted(options.signal, "Session bundle import was cancelled.");
			staged = await stageSessionLog(
				await fs.realpath(logRoot),
				prepared.bundle.session.id,
				`import-${randomUUIDv7()}`,
				prepared.logBytes,
				fileIo
			);
			result = await publishStagedSessionImport(
				prepared,
				options,
				staged,
				identity,
				publication
			);
		} catch (error) {
			failure = error;
		}
		const cleanupFailure = await releaseSessionImportResources(
			leases,
			staged,
			publication
		);
		if (cleanupFailure !== undefined) {
			failure = publication.logPublished
				? new SessionBundleImportIndeterminateError(
						"Session bundle was published, but import cleanup did not complete.",
						{ cause: cleanupFailure }
					)
				: (failure ?? cleanupFailure);
		}
		if (
			failure !== undefined &&
			publication.logPublished &&
			!(failure instanceof SessionBundleImportIndeterminateError)
		) {
			failure = new SessionBundleImportIndeterminateError(
				"Session bundle was published, but its import receipt could not be confirmed.",
				{ cause: failure }
			);
		}
		if (failure !== undefined) {
			throw failure;
		}
		if (result === undefined) {
			throw new Error("Session bundle import completed without a receipt.");
		}
		return result;
	};

	const importSessionBundle = async (
		bundlePath: string,
		options: Readonly<{
			fileSystem?: SessionBundleImportFileSystem;
			signal?: AbortSignal;
		}>
	): Promise<SessionBundleImportResult> => {
		throwIfAborted(options.signal, "Session bundle import was cancelled.");
		const prepared = await prepareSessionBundleImport(bundlePath);
		throwIfAborted(options.signal, "Session bundle import was cancelled.");
		const identity = sessionBundleImportIdentity(prepared);
		await ensureDirectoryDurable(logRoot);
		const existing = await recoverExistingSessionImport(
			prepared,
			options,
			identity
		);
		if (existing !== undefined) {
			return existing;
		}
		return await importNewSessionBundle(prepared, options, identity);
	};

	const commitWrite = async (
		sessionId: SessionId,
		write: SessionWrite
	): Promise<SessionWriteOutcome> => {
		try {
			const committed = await append(sessionId, write);
			return toReceipt(committed.entry, "ready");
		} catch (error) {
			return sessionWriteOutcomeFromError(write.operationId, error);
		}
	};

	const isSessionImportActivationPending = async (
		sessionId: SessionId
	): Promise<boolean> =>
		(await readSessionImportActivationMarker(logRoot, sessionId)) !== undefined;

	const isSessionImported = async (sessionId: SessionId): Promise<boolean> =>
		(await isSessionImportActivationPending(sessionId)) ||
		projection.isSessionImportActivationConfirmed(sessionId);

	const confirmSessionImportActivation = async (
		sessionId: SessionId
	): Promise<void> =>
		withTemporaryWriter(
			sessionId,
			async () => {
				await checkDeletedMarker(sessionId);
				const marker = await readSessionImportActivationMarker(
					logRoot,
					sessionId
				);
				if (marker === undefined) {
					return;
				}
				if (
					marker.workspaceId !== projection.workspaceId ||
					!projection.isBoundToWorkspace(sessionId)
				) {
					throw new SessionBundleImportConflictError(
						"Imported Session is not bound to this local workspace."
					);
				}
				await (await projected.open(sessionId)).atHead();
				const { state } = await sessionLog.read(sessionId);
				const importedCut = state.entries.find(
					({ envelope }) => envelope.sequence === marker.cutSequence
				);
				if (
					state.logId !== marker.logId ||
					importedCut?.envelope.entryHash !== marker.cutHash
				) {
					throw new SessionBundleImportConflictError(
						"Imported Session log no longer matches its durable activation marker."
					);
				}
				const previousActivation = state.entries.find(
					({ envelope }) =>
						envelope.operationId === marker.activationOperationId
				);
				if (previousActivation === undefined) {
					const outcome = await commitWrite(sessionId, {
						operationId: marker.activationOperationId,
						payload: { bundleIdentity: marker.bundleIdentity },
						type: "session.activation-confirmed",
					});
					requireSessionWriteReady(outcome);
				} else if (
					previousActivation.envelope.type !== "session.activation-confirmed" ||
					previousActivation.envelope.sequence <= marker.cutSequence ||
					previousActivation.envelope.payload.bundleIdentity !==
						marker.bundleIdentity
				) {
					throw new SessionBundleImportConflictError(
						"Imported Session activation operation conflicts with its historical log."
					);
				}
				await (await projected.open(sessionId)).atHead();
				await removeSessionImportActivationMarker(logRoot, sessionId, fileIo);
			},
			undefined,
			true
		);

	const projectCreation = (created: CommittedLogEntry): SessionWriteOutcome => {
		if (created.receiptBlocked) {
			return toReceipt(created.entry, "blocked");
		}
		const sessionId = created.entry.envelope.sessionId;
		try {
			const generation = projection.getMaintenanceState().generation;
			const cursor = projection.getCursor(sessionId);
			if (sessionProjectionMatchesState(cursor, created.state, generation)) {
				return toReceipt(created.entry, "ready");
			}
			const replace = cursor === undefined || cursor.generation !== generation;
			const pendingEntries = replace
				? created.state.entries
				: created.state.entries.filter(
						({ envelope }) => envelope.sequence >= cursor.nextSequence
					);
			projection.projectEntries(
				sessionId,
				pendingEntries,
				created.state,
				cursor,
				replace ? "replace" : "append"
			);
			if (
				!sessionProjectionMatchesState(
					projection.getCursor(sessionId),
					created.state,
					projection.getMaintenanceState().generation
				)
			) {
				throw new SessionLogError(
					"session_projection_blocked",
					sessionId,
					"SQLite projection did not reach the committed Session log head."
				);
			}
			return toReceipt(created.entry, "ready");
		} catch {
			if (
				sessionProjectionMatchesState(
					projection.getCursor(sessionId),
					created.state,
					projection.getMaintenanceState().generation
				)
			) {
				return toReceipt(created.entry, "ready");
			}
			return toReceipt(created.entry, "blocked");
		}
	};

	const withWriteOutcome = async (
		sessionId: SessionId,
		operationId: string,
		operation: () => Promise<SessionWriteOutcome>
	): Promise<SessionWriteOutcome> => {
		try {
			return await withTemporaryWriter(sessionId, operation);
		} catch (error) {
			return sessionWriteOutcomeFromError(operationId, error);
		}
	};

	const createEmptySession = async (input: CreateEmptySessionInput) => {
		const sessionId = input.id ?? toSessionId(randomUUIDv7());
		const operationId = `create-${sessionId}`;
		try {
			const createdAt = input.createdAt ?? new Date();
			return await withTemporaryWriter(sessionId, async () => {
				await projected.open(sessionId);
				await assertSessionWritable(sessionId);
				const created = await createSessionLogFile(
					logRoot,
					sessionId,
					initialCreation({ ...input, id: sessionId }, createdAt),
					fileIo,
					projection.workspaceId,
					() => projection.isBoundToWorkspace(sessionId),
					() => projection.isBoundToAnotherWorkspace(sessionId),
					() => projection.bindSessionToWorkspace(sessionId)
				);
				return {
					created: created.createdNew,
					id: sessionId,
					writeOutcome: projectCreation(created),
				};
			});
		} catch (error) {
			return {
				created: false,
				id: sessionId,
				writeOutcome: sessionWriteOutcomeFromError(operationId, error),
			};
		}
	};

	const createSessionWithExternalizedMessage = async (
		input: CreateSessionInput
	) => {
		const sessionId = input.id ?? toSessionId(randomUUIDv7());
		const operationId = `create-${sessionId}`;
		let message = input.message;
		try {
			return await withTemporaryWriter(sessionId, async () => {
				await projected.open(sessionId);
				await assertSessionWritable(sessionId);
				let lease = pendingCreationAttachmentLeases.get(sessionId);
				if (
					lease === undefined &&
					projectionStore.attachmentStore !== undefined
				) {
					lease =
						await projectionStore.attachmentStore.externalizeMessagesWithLease(
							[input.message],
							undefined,
							{ rejectInvalid: true }
						);
				}
				message = lease?.messages[0] ?? input.message;
				const externalization = lease ?? {
					messages: [message],
					release: async () => undefined,
				};
				const externalizedInput = { ...input, message };
				try {
					const createdAt = input.createdAt ?? new Date();
					const initialRecord =
						input.initialRecord ??
						initialRecordFor(externalizedInput, sessionId);
					const creation: SessionCreation = {
						createdAt,
						createdAtIsExplicit: input.createdAt !== undefined,
						editMode: "hashline",
						initialRecord,
						lastMessageAt: createdAt,
						model: input.model,
						pinned: false,
						thinkingLevel: input.thinkingLevel,
						title: titleFor(externalizedInput),
					};
					const created = await createSessionLogFile(
						logRoot,
						sessionId,
						creation,
						fileIo,
						projection.workspaceId,
						() => projection.isBoundToWorkspace(sessionId),
						() => projection.isBoundToAnotherWorkspace(sessionId),
						() => projection.bindSessionToWorkspace(sessionId)
					);
					const writeOutcome = projectCreation(created);
					if (writeOutcome.kind === "indeterminate") {
						pendingCreationAttachmentLeases.set(sessionId, externalization);
					} else {
						await releasePendingCreationAttachmentLease(
							sessionId,
							externalization
						);
					}
					return {
						created: created.createdNew,
						id: sessionId,
						message,
						writeOutcome,
					};
				} catch (error) {
					const writeOutcome = sessionWriteOutcomeFromError(operationId, error);
					if (writeOutcome.kind === "indeterminate") {
						pendingCreationAttachmentLeases.set(sessionId, externalization);
					} else {
						await releasePendingCreationAttachmentLease(
							sessionId,
							externalization
						);
					}
					return { created: false, id: sessionId, message, writeOutcome };
				}
			});
		} catch (error) {
			return {
				created: false,
				id: sessionId,
				message,
				writeOutcome: sessionWriteOutcomeFromError(operationId, error),
			};
		}
	};
	const createSession = async (input: CreateSessionInput) => {
		const { message: _message, ...created } =
			await createSessionWithExternalizedMessage(input);
		return created;
	};

	const commitSessionRecord = async (
		input: CommitSessionRecordInput
	): Promise<SessionWriteOutcome> => {
		const operationId = `record-${input.record.id}`;
		const writeOutcome = await withWriteOutcome(
			input.sessionId,
			operationId,
			() =>
				commitWrite(input.sessionId, {
					operationId,
					payload: {
						record: input.record,
						...omitUndefined({
							sessionModel: input.sessionModel,
							sessionThinkingLevel: input.sessionThinkingLevel,
						}),
					},
					type: "record.committed",
				})
		);
		if (
			writeOutcome.kind === "indeterminate" &&
			input.externalizationLease !== undefined
		) {
			await trackIndeterminateAttachmentLease(
				input.sessionId,
				operationId,
				input.externalizationLease
			);
		}
		return writeOutcome;
	};
	const pluginSessionStateFor = (
		entries: readonly SessionLogEntry[],
		pluginId: string,
		key: string,
		selectedHistoryEntryIds?: ReadonlySet<string>
	): PluginSessionStateRecord | undefined => {
		let current: PluginSessionStateRecord | undefined;
		for (const { envelope } of entries) {
			if (
				selectedHistoryEntryIds !== undefined &&
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
	const getPluginSessionState = async (
		sessionId: SessionId,
		pluginId: string,
		key: string
	): Promise<PluginSessionStateRecord | undefined> => {
		validatePluginSessionStatePluginId(pluginId);
		validatePluginSessionStateKey(key);
		const [state, historyPath] = await Promise.all([
			(await (await projected.open(sessionId)).atHeadState()).state,
			readSessionHistoryPath(sessionId),
		]);
		const selectedHistoryEntryIds = new Set(
			historyPath.entries.map(({ id }) => id)
		);
		return pluginSessionStateFor(
			state.entries,
			pluginId,
			key,
			selectedHistoryEntryIds
		);
	};
	const mutatePluginSessionState = async (
		sessionId: SessionId,
		pluginId: string,
		mutation: PluginSessionStateMutation
	): Promise<PluginSessionStateMutationResult> => {
		const { key, kind, operationId, schemaVersion } = mutation;
		try {
			validatePluginSessionStatePluginId(pluginId);
			validatePluginSessionStateKey(key);
			validatePluginSessionStateSchemaVersion(schemaVersion);
			if (
				!Number.isSafeInteger(mutation.expectedHistoryGeneration) ||
				mutation.expectedHistoryGeneration < 0
			) {
				throw new Error("Plugin Session State history generation is invalid.");
			}
			if (kind === "set") {
				serializePluginSessionStateValue(mutation.value);
			}
			if (!isValidSessionLogIdentifier(operationId)) {
				throw new Error("Plugin Session State operation ID is invalid.");
			}
			const write: SessionWrite = {
				operationId,
				payload:
					kind === "set"
						? { key, pluginId, schemaVersion, value: mutation.value }
						: { key, pluginId, schemaVersion },
				type: kind === "set" ? "plugin.state-replaced" : "plugin.state-deleted",
			};
			return await withTemporaryWriter(sessionId, async () => {
				await assertSessionWritable(sessionId);
				const state = (await (await projected.open(sessionId)).atHeadState())
					.state;
				const historyTree = buildSessionHistoryTreeEntries(
					state,
					sessionId,
					state.nextSequence - 1
				);
				if (
					historyTree.historyGeneration !== mutation.expectedHistoryGeneration
				) {
					return {
						kind: "written",
						writeOutcome: sessionWriteOutcomeFromError(
							operationId,
							new SessionLogError(
								"session_operation_conflict",
								sessionId,
								"Plugin Session State belongs to a different history path.",
								{ operationId }
							)
						),
					};
				}
				if (testObserver?.onPluginWriteGenerationValidated !== undefined) {
					await testObserver.onPluginWriteGenerationValidated(write);
				}
				const selectedHistoryEntryIds = new Set(
					historyTree.entries
						.filter(({ selectedPath }) => selectedPath)
						.map(({ id }) => id)
				);
				const historyAwareWrite = withSessionHistoryReferences(
					sessionId,
					state,
					write
				);
				const existingOperation = findOperation(
					state,
					historyAwareWrite,
					sessionId
				);
				if (existingOperation === undefined) {
					const previous = pluginSessionStateFor(
						state.entries,
						pluginId,
						key,
						selectedHistoryEntryIds
					);
					if (
						previous !== undefined &&
						previous.schemaVersion !== schemaVersion
					) {
						return {
							kind: "schema-version-mismatch",
							storedSchemaVersion: previous.schemaVersion,
						};
					}
				}
				try {
					const committed = await append(sessionId, write, {
						generation: mutation.expectedHistoryGeneration,
						message:
							"Plugin Session State belongs to a different history path.",
					});
					return {
						kind: "written",
						writeOutcome: toReceipt(committed.entry, "ready"),
					};
				} catch (error) {
					return {
						kind: "written",
						writeOutcome: sessionWriteOutcomeFromError(operationId, error),
					};
				}
			});
		} catch (error) {
			return {
				kind: "written",
				writeOutcome: sessionWriteOutcomeFromError(operationId, error),
			};
		}
	};
	const appendPluginSessionHistoryEntry = async (
		sessionId: SessionId,
		pluginId: string,
		input: PluginSessionHistoryAppendInput
	): Promise<PluginSessionHistoryAppendResult> => {
		const entryId = sessionHistoryEntryIdForOperation(
			sessionId,
			input.operationId
		);
		try {
			validatePluginSessionHistoryPluginId(pluginId);
			validatePluginSessionHistoryType(input.type);
			if (!isValidSessionLogIdentifier(input.operationId)) {
				throw new Error("Plugin Session History operation ID is invalid.");
			}
			if (
				!Number.isSafeInteger(input.expectedHistoryGeneration) ||
				input.expectedHistoryGeneration < 0
			) {
				throw new Error(
					"Plugin Session History history generation is invalid."
				);
			}
			const payload = copyPluginSessionHistoryPayload(input.payload);
			return await withTemporaryWriter(sessionId, async () => {
				await assertSessionWritable(sessionId);
				const state = (await (await projected.open(sessionId)).atHeadState())
					.state;
				const historyTree = buildSessionHistoryTreeEntries(
					state,
					sessionId,
					state.nextSequence - 1
				);
				if (historyTree.historyGeneration !== input.expectedHistoryGeneration) {
					return {
						entryId,
						writeOutcome: sessionWriteOutcomeFromError(
							input.operationId,
							new SessionLogError(
								"session_operation_conflict",
								sessionId,
								"Plugin Session History entry belongs to a different history path.",
								{ operationId: input.operationId }
							)
						),
					};
				}
				if (testObserver?.onPluginWriteGenerationValidated !== undefined) {
					await testObserver.onPluginWriteGenerationValidated({
						operationId: input.operationId,
						payload: { entryType: input.type, payload, pluginId },
						type: "plugin.entry-appended",
					});
				}
				try {
					const committed = await append(
						sessionId,
						{
							operationId: input.operationId,
							payload: { entryType: input.type, payload, pluginId },
							type: "plugin.entry-appended",
						},
						{
							generation: input.expectedHistoryGeneration,
							message:
								"Plugin Session History entry belongs to a different history path.",
						}
					);
					return {
						entryId,
						writeOutcome: toReceipt(committed.entry, "ready"),
					};
				} catch (error) {
					return {
						entryId,
						writeOutcome: sessionWriteOutcomeFromError(
							input.operationId,
							error
						),
					};
				}
			});
		} catch (error) {
			return {
				entryId,
				writeOutcome: sessionWriteOutcomeFromError(input.operationId, error),
			};
		}
	};
	const hasSessionHistoryEntry = async (
		sessionId: SessionId,
		entryId: SessionHistoryEntryId
	): Promise<boolean> => {
		const state = (await (await projected.open(sessionId)).atHeadState()).state;
		return historyEntryExists(state, entryId);
	};
	const navigateSessionHistory = async (
		sessionId: SessionId,
		request: SessionHistoryNavigationRequest
	): Promise<SessionWriteOutcome> =>
		withWriteOutcome(sessionId, request.operationId, async () => {
			await assertSessionWritable(sessionId);
			const state = (await (await projected.open(sessionId)).atHeadState())
				.state;
			return await commitWrite(sessionId, {
				operationId: request.operationId,
				payload: {
					activeLeafId: request.targetEntryId,
					previousActiveLeafId: activeHistoryLeafFromState(state),
				},
				type: "session.history-navigated",
			});
		});

	const appendContextEdit = async (
		sessionId: SessionId,
		input: SessionContextEdit
	): Promise<SessionWriteOutcome> => {
		const edit = sessionContextEditSchema.parse(input);
		return withWriteOutcome(sessionId, edit.operationId, () =>
			commitWrite(sessionId, {
				operationId: edit.operationId,
				payload: edit,
				type: "context.edited",
			})
		);
	};
	const updateSessionSubmission = async (
		input: UpdateSessionSubmissionInput
	): Promise<SessionWriteOutcome> => {
		const operationId = input.operationId ?? randomUUIDv7();
		return withWriteOutcome(input.sessionId, operationId, () =>
			commitWrite(input.sessionId, {
				operationId,
				payload: omitUndefined({
					failure: input.failure,
					messageId: input.messageId,
					recordId: input.recordId,
					status: input.status,
					submissionId: input.submissionId,
				}),
				type: "submission.status-updated",
			})
		);
	};
	const updateSession = async (
		sessionId: SessionId,
		data: UpdateSessionInput
	): Promise<SessionWriteOutcome> => {
		const payload = omitUndefined({ title: data.title, pinned: data.pinned });
		const operationId = data.operationId ?? randomUUIDv7();
		return withWriteOutcome(sessionId, operationId, () =>
			commitWrite(sessionId, {
				operationId,
				payload,
				type: "session.metadata-updated",
			})
		);
	};
	const setEditMode = async (
		sessionId: SessionId,
		mode: EditMode,
		operationId?: string
	): Promise<SessionWriteOutcome> => {
		const resolvedOperationId = operationId ?? randomUUIDv7();
		return withWriteOutcome(sessionId, resolvedOperationId, () =>
			commitWrite(sessionId, {
				operationId: resolvedOperationId,
				payload: { editMode: mode },
				type: "session.metadata-updated",
			})
		);
	};
	const existingUsageCreatedAt = async (
		input: CreateSessionUsageEntryInput,
		operationId: string
	): Promise<Date | undefined> => {
		const logPath = resolveSessionLogFilePath(
			path.resolve(logRoot),
			input.sessionId
		);
		const { state } = await readLog(logPath, input.sessionId);
		const previous = state.entries.find(
			({ envelope }) =>
				envelope.operationId === operationId &&
				envelope.type === "usage.committed"
		);
		if (previous === undefined) {
			return;
		}
		const { createdAt, ...previousPayload } = previous.envelope.payload;
		const previousSemanticPayload = {
			compactionId: previousPayload.compactionId ?? null,
			costUsd: previousPayload.costUsd ?? null,
			id: previousPayload.id,
			kind: previousPayload.kind,
			model: previousPayload.model,
			usage: previousPayload.usage,
		};
		const requestedSemanticPayload = {
			compactionId: input.compactionId ?? null,
			costUsd: input.costUsd,
			id: input.id,
			kind: input.kind,
			model: input.model,
			usage: input.usage,
		};
		if (
			!isCanonicalTimestamp(createdAt) ||
			sessionLogOperationDigest("usage.committed", previousSemanticPayload) !==
				sessionLogOperationDigest("usage.committed", requestedSemanticPayload)
		) {
			return;
		}
		return new Date(createdAt);
	};
	const isLegacyPendingUsageTruncation = (
		pendingIntent: SessionWriteIntent | undefined,
		operationId: string,
		error: unknown
	): boolean =>
		pendingIntent?.operationId === operationId &&
		pendingIntent.type === "usage.committed" &&
		pendingIntent.timestamp === undefined &&
		error instanceof SessionLogError &&
		error.code === "session_log_truncated";
	const retryableUsageCreatedAt = async (
		input: CreateSessionUsageEntryInput,
		operationId: string
	): Promise<Date> => {
		if (input.createdAt !== undefined) {
			return input.createdAt;
		}
		const pendingIntent = await readSessionWriteIntent(
			logRoot,
			input.sessionId,
			fileIo
		);
		if (
			pendingIntent?.operationId === operationId &&
			pendingIntent.type === "usage.committed" &&
			pendingIntent.timestamp !== undefined
		) {
			return new Date(pendingIntent.timestamp);
		}
		try {
			return (await existingUsageCreatedAt(input, operationId)) ?? new Date();
		} catch (error) {
			if (
				isCode(error, "ENOENT") ||
				isLegacyPendingUsageTruncation(pendingIntent, operationId, error)
			) {
				return new Date();
			}
			throw error;
		}
	};

	const createSessionUsageEntry = async (
		input: CreateSessionUsageEntryInput
	): Promise<{
		entry?: SessionUsageEntry;
		writeOutcome: SessionWriteOutcome;
	}> => {
		const operationId = `usage-${input.id}`;
		const writeOutcome = await withWriteOutcome(
			input.sessionId,
			operationId,
			async () => {
				const createdAt = await retryableUsageCreatedAt(input, operationId);
				const payload = {
					compactionId: input.compactionId ?? null,
					costUsd: input.costUsd,
					createdAt: createdAt.toISOString(),
					id: input.id,
					kind: input.kind,
					model: input.model,
					usage: input.usage,
				};
				return commitWrite(input.sessionId, {
					operationId,
					payload,
					type: "usage.committed",
				});
			}
		);
		if (
			writeOutcome.kind !== "committed" ||
			writeOutcome.projection !== "ready"
		) {
			return { writeOutcome };
		}
		try {
			const entries = await projectionStore.listSessionUsageEntries(
				input.sessionId
			);
			const entry = entries.find(({ id }) => id === input.id);
			if (entry !== undefined) {
				return { entry, writeOutcome };
			}
		} catch {
			// The JSONL commit remains authoritative when its read projection is unavailable.
		}
		return {
			writeOutcome: { ...writeOutcome, projection: "blocked" },
		};
	};
	const assertCompactionRetryTimestampRecoverable = (
		input: AppendSessionCompactionInput,
		operationId: string,
		matchingIntent: SessionWriteIntent | undefined,
		retryCreatedAt: string | undefined
	): void => {
		if (
			matchingIntent === undefined ||
			retryCreatedAt !== undefined ||
			input.createdAt !== undefined
		) {
			return;
		}
		throw new SessionLogError(
			"session_log_write_indeterminate",
			input.sessionId,
			"Legacy pending compaction has no recoverable creation timestamp.",
			{
				offset: matchingIntent.expectedOffset,
				operationId,
				sequence: matchingIntent.sequence,
			}
		);
	};

	const prepareCompactionRetry = async (
		input: AppendSessionCompactionInput,
		operationId: string,
		pendingIntent: SessionWriteIntent | undefined
	): Promise<
		Readonly<{
			envelopeTimestamp?: string;
			retryInput: AppendSessionCompactionInput;
			state: SessionLogState;
		}>
	> => {
		const matchingIntent =
			pendingIntent?.operationId === operationId &&
			pendingIntent.type === "compaction.committed"
				? pendingIntent
				: undefined;
		const pendingAppend =
			matchingIntent === undefined
				? undefined
				: await stateForPendingAppend(input.sessionId, matchingIntent);
		const state =
			pendingAppend?.state ??
			(await (await projected.open(input.sessionId)).atHeadState()).state;
		const retryCreatedAt =
			pendingAppend?.createdAt ?? matchingIntent?.timestamp;
		assertCompactionRetryTimestampRecoverable(
			input,
			operationId,
			matchingIntent,
			retryCreatedAt
		);
		const recoveredCreatedAt =
			retryCreatedAt === undefined ? undefined : new Date(retryCreatedAt);
		const envelopeTimestamp =
			matchingIntent === undefined
				? undefined
				: (matchingIntent.timestamp ??
					pendingAppend?.envelopeTimestamp ??
					input.createdAt?.toISOString());
		const retryInput =
			recoveredCreatedAt === undefined
				? input
				: {
						...input,
						completedAt:
							input.completedAt ?? input.createdAt ?? recoveredCreatedAt,
						createdAt: input.createdAt ?? recoveredCreatedAt,
					};
		return {
			...omitUndefined({ envelopeTimestamp }),
			retryInput,
			state,
		};
	};

	const assertPendingCompactionMatches = (
		pendingIntent: SessionWriteIntent | undefined,
		operationId: string,
		payload: Readonly<Record<string, unknown>>,
		sessionId: SessionId,
		state: SessionLogState
	): void => {
		if (
			pendingIntent?.operationId !== operationId ||
			pendingIntent.type !== "compaction.committed"
		) {
			return;
		}
		const preparedWrite = withSessionHistoryReferences(sessionId, state, {
			operationId,
			payload,
			type: "compaction.committed",
		});
		assertSameSessionWriteIntent(
			pendingIntent,
			{
				operationDigest: sessionLogOperationDigest(
					preparedWrite.type,
					preparedWrite.payload
				),
				operationId,
				type: preparedWrite.type,
			},
			sessionId
		);
	};

	const assertCompactionReferencesIfNew = (
		state: SessionLogState,
		compaction: SessionCompaction,
		operationId: string
	): void => {
		if (
			state.entries.some(({ envelope }) => envelope.operationId === operationId)
		) {
			return;
		}
		const availableMessageIds = new Set(
			state.entries.flatMap(
				(entry) =>
					recordFromSessionLogEntry(entry)?.messages.map(({ id }) => id) ?? []
			)
		);
		assertCompactionMessageReferences(compaction, availableMessageIds);
	};

	const appendCompaction = async (input: AppendSessionCompactionInput) => {
		const id: CompactionId = input.id ?? toCompactionId(randomUUIDv7());
		const operationId = `compaction-${id}`;
		const result = await withTemporaryWriter(input.sessionId, async () => {
			await projected.open(input.sessionId);
			await assertSessionWritable(input.sessionId);
			const pendingIntent = await readSessionWriteIntent(
				logRoot,
				input.sessionId,
				fileIo
			);
			const { envelopeTimestamp, retryInput, state } =
				await prepareCompactionRetry(input, operationId, pendingIntent);
			const { compaction, payload } = compactionForAppend(
				retryInput,
				id,
				operationId,
				state
			);
			assertPendingCompactionMatches(
				pendingIntent,
				operationId,
				payload,
				input.sessionId,
				state
			);
			assertCompactionReferencesIfNew(state, compaction, operationId);
			const write: SessionWrite = omitUndefined({
				envelopeTimestamp,
				operationId,
				payload,
				type: "compaction.committed",
			});
			const writeOutcome = await commitWrite(input.sessionId, write);
			return writeOutcome.kind === "committed"
				? { compaction, writeOutcome }
				: { writeOutcome };
		}).catch((error) => ({
			writeOutcome: sessionWriteOutcomeFromError(operationId, error),
		}));
		if (
			result.writeOutcome.kind === "indeterminate" &&
			input.externalizationLease !== undefined
		) {
			await trackIndeterminateAttachmentLease(
				input.sessionId,
				operationId,
				input.externalizationLease
			);
		}
		return result;
	};
	const deletionWrite = async (
		sessionId: SessionId,
		operationId: string
	): Promise<
		| Readonly<{ logId: string; receipt: SessionDeletionReceipt }>
		| Readonly<{ writeOutcome: SessionWriteOutcome }>
	> => {
		const pendingIntent = await sessionLog.readWriteIntent(sessionId);
		if (pendingIntent?.operationId === operationId) {
			const { state } = await sessionLog.read(sessionId);
			const writeOutcome = await commitWrite(sessionId, {
				operationId,
				payload: {},
				type: "session.deleted",
			});
			return writeOutcome.kind === "committed"
				? { logId: state.logId, receipt: writeOutcome }
				: { writeOutcome };
		}
		const { state } = await sessionLog.read(sessionId);
		const deletion = findOperation(
			state,
			{ operationId, payload: {}, type: "session.deleted" },
			sessionId
		);
		if (deletion !== undefined) {
			return {
				logId: state.logId,
				receipt: {
					entryHash: deletion.envelope.entryHash,
					operationId,
					sequence: deletion.envelope.sequence,
				},
			};
		}
		await assertSessionDeletionAllowed(sessionId);
		const writeOutcome = await commitWrite(sessionId, {
			operationId,
			payload: {},
			type: "session.deleted",
		});
		if (writeOutcome.kind !== "committed") {
			return { writeOutcome };
		}
		return { logId: state.logId, receipt: writeOutcome };
	};
	const clearPendingDeletionWriteIntent = async (
		sessionId: SessionId,
		operationId: string
	): Promise<void> => {
		const pendingIntent = await sessionLog.readWriteIntent(sessionId);
		if (pendingIntent === undefined) {
			return;
		}
		if (
			pendingIntent.type !== "session.deleted" ||
			pendingIntent.operationId !== operationId
		) {
			throw new SessionLogError(
				"session_operation_conflict",
				sessionId,
				"Session deletion conflicts with a different pending Session write."
			);
		}
		await sessionLog.clearWriteIntent(pendingIntent);
	};

	const removeDeletedSessionLog = async (
		sessionId: SessionId,
		marker: Readonly<{ logId: string; receipt: SessionDeletionReceipt }>
	): Promise<Readonly<{ logRemoved: boolean; markerDurable: boolean }>> => {
		let markerDurable = false;
		try {
			await ensureDirectoryDurable(logRoot);
			await writeDeletedMarker(
				logRoot,
				sessionId,
				marker.logId,
				marker.receipt,
				fileIo
			);
			markerDurable = true;
			await clearPendingDeletionWriteIntent(
				sessionId,
				marker.receipt.operationId
			);
			await sessionLog.removeLog(sessionId);
			return { logRemoved: true, markerDurable };
		} catch {
			return { logRemoved: false, markerDurable };
		}
	};
	const deletionCleanupPending = (
		receipt: SessionWriteReceipt
	): SessionDeletionOutcome => ({
		code: "session_cleanup_pending",
		kind: "cleanup-pending",
		message:
			"Session deletion is committed, but local cleanup is still pending.",
		operationId: receipt.operationId,
		receipt,
	});
	const finalizeDeletion = async (
		sessionId: SessionId,
		receipt: SessionWriteReceipt,
		markerDurable: boolean,
		logRemoved: boolean
	): Promise<SessionDeletionOutcome> => {
		if (!markerDurable) {
			return { ...receipt, projection: "blocked" };
		}
		if (!logRemoved) {
			return deletionCleanupPending(receipt);
		}
		try {
			await projectionStore.deleteSession(sessionId);
			return { ...receipt, projection: "ready" };
		} catch {
			return deletionCleanupPending(receipt);
		}
	};
	const deleteSession = async (
		sessionId: SessionId
	): Promise<SessionDeletionOutcome> => {
		const operationId = sessionDeletionOperationId(sessionId);
		let receipt: SessionWriteReceipt | undefined;
		let markerDurable = false;
		try {
			return await withTemporaryWriter(
				sessionId,
				async () => {
					let logRemoved = false;
					let writeOutcome: SessionWriteOutcome | undefined;
					await withSessionCatalogLifecycleGate(logRoot, async () => {
						const marker = await sessionLog.readDeletedMarker(sessionId);
						if (marker !== undefined) {
							receipt = {
								entryHash: marker.entryHash,
								kind: "committed",
								operationId: marker.operationId,
								projection: "blocked",
								sequence: marker.sequence,
							};
							const cleanup = await removeDeletedSessionLog(sessionId, {
								logId: marker.logId,
								receipt: marker,
							});
							markerDurable = cleanup.markerDurable;
							logRemoved = cleanup.logRemoved;
							if (markerDurable) {
								projectionStore.markSessionDeleted(sessionId);
							}
							return;
						}
						await assertSessionWritable(sessionId);
						const deletion = await deletionWrite(sessionId, operationId);
						if ("writeOutcome" in deletion) {
							writeOutcome = deletion.writeOutcome;
							return;
						}
						receipt = {
							...deletion.receipt,
							kind: "committed",
							projection: "blocked",
						};
						const cleanup = await removeDeletedSessionLog(sessionId, {
							logId: deletion.logId,
							receipt: deletion.receipt,
						});
						markerDurable = cleanup.markerDurable;
						logRemoved = cleanup.logRemoved;
						if (markerDurable) {
							projectionStore.markSessionDeleted(sessionId);
						}
					});
					if (writeOutcome !== undefined) {
						return writeOutcome;
					}
					if (receipt === undefined) {
						throw new Error(
							"The committed Session deletion receipt is missing."
						);
					}
					return await finalizeDeletion(
						sessionId,
						receipt,
						markerDurable,
						logRemoved
					);
				},
				undefined,
				true,
				() => testObserver?.onSessionDeletionWriterOperationEnqueued?.()
			);
		} catch (error) {
			if (receipt === undefined) {
				return sessionWriteOutcomeFromError(operationId, error);
			}
			return markerDurable
				? deletionCleanupPending(receipt)
				: { ...receipt, projection: "blocked" };
		}
	};
	const assertSessionDeletionAllowed = async (
		sessionId: SessionId
	): Promise<void> => {
		const recovery = projectionStore.fileObservationStore?.recovery;
		if (recovery === undefined) {
			return;
		}
		await recovery.ensureReady?.();
		const unresolved = (await recovery.listUnresolvedRecoveries()).filter(
			(entry) => entry.originSessionId === sessionId
		);
		if (unresolved.length === 0) {
			return;
		}
		const error = new Error(
			"Session deletion is blocked until its unresolved recovery is resolved, exported, discarded, or cancelled."
		) as Error & { code: string; details: Record<string, unknown> };
		error.code = "session-recovery-required";
		error.details = {
			actions: ["resolve", "export", "discard", "cancel"],
			recoveryIds: unresolved.map(({ id }) => id),
		};
		throw error;
	};
	const assertResetAllowed = (): Promise<void> =>
		projectionStore.assertResetAllowed();

	const findSessionLogIds = async (): Promise<SessionId[]> => {
		await ensureDirectoryDurable(logRoot);
		const root = await fs.realpath(logRoot);
		const entries = await fs.readdir(root, { withFileTypes: true });
		const sessionIds: SessionId[] = [];
		for (const entry of entries) {
			if (!entry.isFile()) {
				continue;
			}
			const sessionId = parseSessionLogFileName(entry.name);
			if (sessionId !== undefined) {
				sessionIds.push(sessionId);
			}
		}
		return sessionIds.sort();
	};

	const findDeletedMarkerSessionIds = async (): Promise<SessionId[]> => {
		const deletedRoot = path.join(await sessionControlRoot(logRoot), "deleted");
		let entries: string[];
		try {
			entries = await fs.readdir(deletedRoot);
		} catch (error) {
			if (isCode(error, "ENOENT")) {
				return [];
			}
			throw error;
		}
		return entries
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => toSessionId(entry.slice(0, -".json".length)))
			.filter(isValidSessionId)
			.sort();
	};

	const readCatalogSnapshot = async (): Promise<
		Readonly<{ deleted: SessionId[]; published: SessionId[] }>
	> => {
		const boundSessionIds = new Set(projection.listAllBoundSessionIds());
		const published = await findSessionLogIds();
		return {
			deleted: await findDeletedMarkerSessionIds(),
			published: published.filter((sessionId) =>
				boundSessionIds.has(sessionId)
			),
		};
	};

	const findPendingDeletionIntentSessionIds = async (): Promise<
		SessionId[]
	> => {
		const intentRoot = path.join(
			await sessionControlRoot(logRoot),
			"indeterminate"
		);
		let entries: string[];
		try {
			entries = await fs.readdir(intentRoot);
		} catch (error) {
			if (isCode(error, "ENOENT")) {
				return [];
			}
			throw error;
		}
		const candidates = entries
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => toSessionId(entry.slice(0, -".json".length)))
			.filter(
				(sessionId) =>
					isValidSessionId(sessionId) &&
					projection.isBoundToWorkspace(sessionId)
			)
			.sort();
		const pending: SessionId[] = [];
		for (const sessionId of candidates) {
			const intent = await sessionLog.readWriteIntent(sessionId);
			if (intent?.type !== "session.deleted") {
				continue;
			}
			if (intent.operationId !== sessionDeletionOperationId(sessionId)) {
				throw new SessionLogError(
					"session_operation_conflict",
					sessionId,
					"Pending Session deletion intent has an unexpected operation ID."
				);
			}
			pending.push(sessionId);
		}
		return pending;
	};

	const findResetSessionIds = async (): Promise<SessionId[]> =>
		[
			...new Set([
				...(await findSessionLogIds()),
				...(await findDeletedMarkerSessionIds()),
			]),
		].sort();

	const preflightResetTargets = async (
		sessionIds: readonly SessionId[]
	): Promise<void> => {
		const root = await fs.realpath(logRoot);
		const published = new Set(await findSessionLogIds());
		const bound = new Set(projection.listAllBoundSessionIds());
		for (const sessionId of sessionIds) {
			const marker = await sessionLog.readDeletedMarker(sessionId);
			if (!published.has(sessionId)) {
				if (marker === undefined) {
					throw new Error(
						`Session reset target ${sessionId} has neither a published log nor a deletion marker.`
					);
				}
				continue;
			}
			const { state } = await readLog(
				resolveSessionLogFilePath(root, sessionId),
				sessionId
			);
			if (marker === undefined) {
				if (!bound.has(sessionId)) {
					throw new Error(
						`Session reset target ${sessionId} has no Workspace binding.`
					);
				}
				continue;
			}
			const deletion = state.entries.find(
				({ envelope }) => envelope.type === "session.deleted"
			);
			if (
				state.logId !== marker.logId ||
				deletion?.envelope.type !== "session.deleted" ||
				deletion.envelope.entryHash !== marker.entryHash ||
				deletion.envelope.operationId !== marker.operationId ||
				deletion.envelope.sequence !== marker.sequence
			) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"Session deletion marker does not match its published log."
				);
			}
		}
	};

	const resetSessionLog = async (sessionId: SessionId): Promise<void> => {
		const existingMarker = await sessionLog.readDeletedMarker(sessionId);
		let logId: string;
		let receipt: SessionDeletionReceipt;
		if (existingMarker === undefined) {
			const deletion = await appendResetDeletion(sessionId);
			logId = deletion.logId;
			receipt = deletion.receipt;
			await sessionLog.writeDeletedMarker(sessionId, logId, receipt);
		} else {
			logId = existingMarker.logId;
			receipt = existingMarker;
			await sessionLog.writeDeletedMarker(sessionId, logId, receipt);
		}
		await clearPendingDeletionWriteIntent(sessionId, receipt.operationId);
		await sessionLog.removeLog(sessionId);
	};

	const resetSessionLogForLifecycle = async (
		sessionId: SessionId
	): Promise<void> => {
		try {
			await resetSessionLog(sessionId);
		} catch (error) {
			const marker = await sessionLog.readDeletedMarker(sessionId);
			if (marker === undefined) {
				throw error;
			}
			try {
				await writeDeletedMarker(
					logRoot,
					sessionId,
					marker.logId,
					marker,
					fileIo
				);
			} catch {
				throw error;
			}
			throw new SessionCleanupPendingError([marker.operationId], error);
		}
	};

	const resetSessionDataUnderCatalogGate = async (
		lockedSessionIds: ReadonlySet<SessionId>
	): Promise<boolean> => {
		const latestSessionIds = await findResetSessionIds();
		if (
			latestSessionIds.some((sessionId) => !lockedSessionIds.has(sessionId))
		) {
			return false;
		}
		await assertResetAllowed();
		await preflightResetTargets(latestSessionIds);
		for (const sessionId of latestSessionIds) {
			await resetSessionLogForLifecycle(sessionId);
		}
		const operationIds = latestSessionIds.map(sessionDeletionOperationId);
		try {
			await projectionStore.resetSessionData();
		} catch (error) {
			throw new SessionCleanupPendingError(operationIds, error);
		}
		return true;
	};

	const resetSessionData = async (): Promise<void> => {
		await assertResetAllowed();
		await ensureDirectoryDurable(logRoot);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const sessionIds = await findResetSessionIds();
			const lockedSessionIds = new Set(sessionIds);
			const writers: SessionWriterLock[] = [];
			let resetCompleted = false;
			try {
				for (const sessionId of sessionIds) {
					writers.push(await acquireSessionWriterLock(logRoot, sessionId));
				}
				resetCompleted = await withSessionCatalogLifecycleGate(logRoot, () =>
					resetSessionDataUnderCatalogGate(lockedSessionIds)
				);
				if (resetCompleted) {
					try {
						await projectionStore.collectAttachments(0);
					} catch (error) {
						throw new SessionCleanupPendingError(
							sessionIds.map(sessionDeletionOperationId),
							error
						);
					}
					return;
				}
			} finally {
				for (const writer of writers.reverse()) {
					await writer.release();
				}
			}
			await Bun.sleep(10);
		}
		throw new Error(
			"Session catalog kept changing during reset; retry the operation."
		);
	};

	const readThroughHandle = async <Result>(
		sessionId: SessionId,
		read: (view: ProjectedSessionStateRead) => Promise<Result>,
		fallback: () => Promise<Result>
	): Promise<Result> => {
		let view: ProjectedSessionStateRead | undefined;
		try {
			await reconcileDeletedSessionIfNeeded(sessionId);
			view = await (await projected.open(sessionId)).atHeadState();
		} catch (error) {
			if (!isCode(error, "ENOENT")) {
				throw error;
			}
			const projectedSessions = await projectionStore.listSessions();
			if (projectedSessions.some((session) => session.id === sessionId)) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"A projected Session is missing its authoritative JSONL log."
				);
			}
		}
		return view === undefined ? await fallback() : await read(view);
	};

	const catalogIssue = (
		sessionId: SessionId,
		error: unknown
	): SessionCatalogIssue => {
		let code = "session_catalog_read_failed";
		let message = "The authoritative Session log could not be read.";
		if (error instanceof SessionLogError) {
			code = error.code;
			message = error.message;
		} else if (typeof error === "object" && error !== null) {
			const errorCode = Reflect.get(error, "code");
			if (typeof errorCode === "string") {
				code = errorCode;
			}
		}
		return {
			...omitUndefined(
				error instanceof SessionLogError
					? {
							offset: error.offset,
							operationId: error.operationId,
							sequence: error.sequence,
						}
					: {}
			),
			code,
			message,
			sessionId,
		};
	};

	const projectExistingSessionLogs = async (
		root: string
	): Promise<{
		issues: Map<SessionId, SessionCatalogIssue>;
		sessionIds: Set<SessionId>;
	}> => {
		const entries = await fs.readdir(root, { withFileTypes: true });
		const issues = new Map<SessionId, SessionCatalogIssue>();
		const sessionIds = new Set<SessionId>();
		for (const entry of entries) {
			if (!entry.isFile()) {
				continue;
			}
			const sessionId = parseSessionLogFileName(entry.name);
			if (sessionId === undefined) {
				continue;
			}
			sessionIds.add(sessionId);
			try {
				await (await projected.open(sessionId)).atHeadState();
			} catch (error) {
				if (
					(error instanceof SessionLogError &&
						error.code === "session_deleted") ||
					(error instanceof Error && error.message === "Session not found")
				) {
					continue;
				}
				issues.set(sessionId, catalogIssue(sessionId, error));
			}
		}
		return { issues, sessionIds };
	};

	const listPendingSessionWriteIntentIds = async (): Promise<SessionId[]> => {
		let markerNames: string[];
		try {
			markerNames = await fs.readdir(
				path.join(await sessionControlRoot(logRoot), "indeterminate")
			);
		} catch (error) {
			if (isCode(error, "ENOENT")) {
				return [];
			}
			throw error;
		}
		const sessionIds: SessionId[] = [];
		for (const markerName of markerNames) {
			if (!markerName.endsWith(".json")) {
				continue;
			}
			const sessionIdValue = markerName.slice(0, -".json".length);
			if (isValidSessionId(sessionIdValue)) {
				sessionIds.push(toSessionId(sessionIdValue));
			}
		}
		return sessionIds;
	};

	const assertPublishedSessionCreationLogExists = async (
		root: string,
		sessionId: SessionId,
		intent: SessionWriteIntent
	): Promise<boolean> => {
		const logPath = resolveSessionLogFilePath(root, sessionId);
		const logInfo = await fs.lstat(logPath).catch((error) => {
			if (isCode(error, "ENOENT")) {
				return;
			}
			throw error;
		});
		if (logInfo === undefined) {
			return false;
		}
		if (!logInfo.isFile() || logInfo.isSymbolicLink()) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				"Published Session creation has an invalid authoritative log file.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		return true;
	};

	const assertNoUnresolvedOwnedSessionCreations = async (
		root: string
	): Promise<void> => {
		for (const sessionId of await listPendingSessionWriteIntentIds()) {
			if (
				projection.isBoundToWorkspace(sessionId) ||
				projection.isBoundToAnotherWorkspace(sessionId)
			) {
				continue;
			}
			const intent = await sessionLog.readWriteIntent(sessionId);
			if (
				intent?.type !== "session.created" ||
				intent.workspaceId !== projection.workspaceId
			) {
				continue;
			}
			if (
				!(await assertPublishedSessionCreationLogExists(
					root,
					sessionId,
					intent
				))
			) {
				continue;
			}
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Published Session creation must be retried before its catalog entry can be read.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
	};

	const collectCatalogSessions = async (
		projected: readonly Session[],
		sessionIds: ReadonlySet<SessionId>,
		issues: Map<SessionId, SessionCatalogIssue>
	): Promise<Session[]> => {
		const sessions: Session[] = [];
		for (const session of projected) {
			try {
				await checkDeletedMarker(session.id);
			} catch (error) {
				if (
					error instanceof SessionLogError &&
					error.code === "session_deleted"
				) {
					continue;
				}
				issues.set(session.id, catalogIssue(session.id, error));
				continue;
			}
			if (issues.has(session.id)) {
				continue;
			}
			if (!sessionIds.has(session.id)) {
				issues.set(
					session.id,
					catalogIssue(
						session.id,
						new SessionLogError(
							"session_log_corrupt",
							session.id,
							"A projected Session is missing its authoritative JSONL log."
						)
					)
				);
				continue;
			}
			sessions.push(session);
		}
		return sessions;
	};

	const listSessionCatalog = async (
		reconcileDeletions = true
	): Promise<SessionCatalogResult> => {
		if (projection.getMaintenanceState().status !== "ready") {
			throw new Error(
				"Session projection rebuild is incomplete; retry `wincode sessions rebuild` before listing Sessions."
			);
		}
		await ensureDirectoryDurable(logRoot);
		const deletionIssues = reconcileDeletions
			? await reconcileDeletedSessions()
			: [];
		const { issues, sessionIds } = await projectExistingSessionLogs(
			await fs.realpath(logRoot)
		);
		for (const issue of deletionIssues) {
			issues.set(issue.sessionId, issue);
		}
		const projected = await projectionStore.listSessions();
		const sessions = await collectCatalogSessions(
			projected,
			sessionIds,
			issues
		);
		return { issues: [...issues.values()], sessions };
	};

	const listSessions = async (): Promise<Session[]> =>
		(await listSessionCatalog()).sessions;

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
		await projected.catchUpRecentModelSelections(sessionIds);
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
		await projected.catchUpRecentModelSelections(sessionIds);
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

	const readCatalogPageInsideLifecycleGate = async (
		cursor: SessionCatalogPageCursor | undefined,
		limit: number
	) =>
		withSessionCatalogLifecycleGate(logRoot, async () => {
			const page = projectionStore.readSessionCatalogPageProjection({
				...(cursor === undefined ? {} : { cursor }),
				limit,
			});
			for (const session of page.sessions) {
				try {
					await checkDeletedMarker(session.id);
				} catch (error) {
					if (isCode(error, "session_deleted")) {
						throw new SessionPaginationError(
							"cursor_expired",
							"Session catalog changed while this page was being read. Refresh the catalog."
						);
					}
					throw error;
				}
			}
			return page;
		});

	const listSessionsPage = async (
		options: SessionPageOptions = {}
	): Promise<SessionCatalogPage> => {
		await projected.reconcileDeleted();
		const limit = parseSessionPageLimit(options.limit);
		let cursor: SessionCatalogPageCursor | undefined;
		if (options.cursor !== undefined) {
			const decoded = decodeSessionPageToken(options.cursor, "catalog");
			if (decoded.kind !== "catalog-page") {
				throw new SessionPaginationError(
					"cursor_invalid",
					"Session cursor is invalid."
				);
			}
			cursor = decoded;
		}
		if (cursor === undefined) {
			await projected.catchUpBoundCatalog();
		} else {
			projected.assertCatalogReadPoint(cursor);
		}
		const page = await readCatalogPageInsideLifecycleGate(cursor, limit);
		const nextCursor =
			page.hasMore && page.lastKey !== undefined
				? encodeSessionPageToken({
						...page.readPoint,
						after: page.lastKey,
						kind: "catalog-page",
					})
				: undefined;
		return {
			...(nextCursor === undefined ? {} : { nextCursor }),
			readPoint: encodeSessionPageToken(page.readPoint),
			sessions: page.sessions,
		};
	};

	const readSessionHistoryPage = async (
		sessionId: SessionId,
		options: SessionPageOptions = {}
	): Promise<SessionHistoryPage> => {
		await projected.reconcileDeleted();
		const limit = parseSessionPageLimit(options.limit);
		let cursor: SessionHistoryPageCursor | undefined;
		if (options.cursor !== undefined) {
			const decoded = decodeSessionPageToken(options.cursor, "history");
			if (decoded.kind !== "history-page") {
				throw new SessionPaginationError(
					"cursor_invalid",
					"Session history cursor is invalid."
				);
			}
			cursor = decoded;
		}
		const handle = await projected.open(sessionId);
		const view =
			cursor === undefined ? await handle.atHead() : await handle.at(cursor);
		return withSessionCatalogLifecycleGate(logRoot, async () => {
			assertSessionHistoryWorkspaceBinding(sessionId, cursor);
			try {
				await checkDeletedMarker(sessionId);
			} catch (error) {
				if (cursor !== undefined && isCode(error, "session_deleted")) {
					throw new SessionPaginationError(
						"cursor_expired",
						"Session history cursor expired because the Session was deleted."
					);
				}
				throw error;
			}
			const page = await view.read(() =>
				projectionStore.readSessionHistoryPageProjection(sessionId, {
					...(cursor === undefined ? {} : { cursor }),
					limit,
				})
			);
			const nextCursor =
				page.hasMore && page.beforeSequence !== undefined
					? encodeSessionPageToken({
							...page.readPoint,
							beforeSequence: page.beforeSequence,
							kind: "history-page",
						})
					: undefined;
			return {
				compactions: page.compactions,
				...(nextCursor === undefined ? {} : { nextCursor }),
				readPoint: encodeSessionPageToken(page.readPoint),
				records: page.records,
				session: page.session,
			};
		});
	};

	// Session logs are append-only: a matching file identity and a size covering
	// the snapshot preserve its validated prefix; replacement or truncation misses.
	const getCachedSessionHistoryTreeSnapshot = async (
		logPath: string,
		sessionId: SessionId,
		cursor: SessionHistoryTreePageCursor
	): Promise<CachedSessionHistoryTreeSnapshot | undefined> => {
		if (cursor.sessionId !== sessionId) {
			return;
		}
		if (cursor.afterSequence > cursor.readPointSequence) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session history tree snapshot is no longer available."
			);
		}
		const key = sessionHistoryTreeSnapshotCacheKey(cursor);
		const cached = sessionHistoryTreeSnapshotCache.get(key);
		if (cached === undefined) {
			return;
		}
		try {
			const stats = await fs.stat(logPath);
			if (
				cached.logPath !== logPath ||
				cached.device !== stats.dev ||
				cached.inode !== stats.ino ||
				stats.size < cached.snapshotByteOffset ||
				(stats.size === cached.fileSize &&
					(stats.mtimeMs !== cached.mtimeMs ||
						stats.ctimeMs !== cached.ctimeMs))
			) {
				sessionHistoryTreeSnapshotCache.delete(key);
				return;
			}
			sessionHistoryTreeSnapshotCache.delete(key);
			sessionHistoryTreeSnapshotCache.set(key, cached);
			return cached;
		} catch {
			sessionHistoryTreeSnapshotCache.delete(key);
			return;
		}
	};

	const cacheSessionHistoryTreeSnapshot = async (
		logPath: string,
		snapshot: SessionHistoryTreeSnapshot,
		tree: Readonly<{
			activeLeafId: SessionHistoryEntryId | null;
			entries: readonly SessionHistoryTreeEntry[];
			historyGeneration: number;
		}>
	): Promise<void> => {
		try {
			const stats = await fs.stat(logPath);
			if (stats.size < snapshot.snapshotByteOffset) {
				return;
			}
			const key = sessionHistoryTreeSnapshotCacheKey(snapshot.readPoint);
			sessionHistoryTreeSnapshotCache.delete(key);
			sessionHistoryTreeSnapshotCache.set(key, {
				activeLeafId: tree.activeLeafId,
				historyGeneration: tree.historyGeneration,
				ctimeMs: stats.ctimeMs,
				device: stats.dev,
				entries: tree.entries,
				fileSize: stats.size,
				inode: stats.ino,
				logPath,
				mtimeMs: stats.mtimeMs,
				readPoint: snapshot.readPoint,
				snapshotByteOffset: snapshot.snapshotByteOffset,
			});
			while (
				sessionHistoryTreeSnapshotCache.size > MAX_CACHED_SESSION_HISTORY_TREES
			) {
				const oldestKey = sessionHistoryTreeSnapshotCache.keys().next().value;
				if (oldestKey === undefined) {
					break;
				}
				sessionHistoryTreeSnapshotCache.delete(oldestKey);
			}
		} catch {
			return;
		}
	};

	const readSessionHistoryTreePage = async (
		sessionId: SessionId,
		options: SessionPageOptions = {}
	): Promise<SessionHistoryTreePage> => {
		await projected.reconcileDeleted();
		const limit = parseSessionPageLimit(options.limit);
		let cursor: SessionHistoryTreePageCursor | undefined;
		if (options.cursor !== undefined) {
			const decoded = decodeSessionPageToken(options.cursor, "history-tree");
			if (decoded.kind !== "history-tree-page") {
				throw new SessionPaginationError(
					"cursor_invalid",
					"Session history tree cursor is invalid."
				);
			}
			cursor = decoded;
		}
		const handle = await projected.open(sessionId);
		const view =
			cursor === undefined ? await handle.atHead() : await handle.at(cursor);
		return withSessionCatalogLifecycleGate(logRoot, async () => {
			assertSessionHistoryWorkspaceBinding(sessionId, cursor);
			try {
				await checkDeletedMarker(sessionId);
			} catch (error) {
				if (cursor !== undefined && isCode(error, "session_deleted")) {
					throw new SessionPaginationError(
						"cursor_expired",
						"Session history tree cursor expired because the Session was deleted."
					);
				}
				throw error;
			}
			return await view.read(async () => {
				const logPath = resolveSessionLogFilePath(
					await fs.realpath(logRoot),
					sessionId
				);
				if (cursor !== undefined) {
					const cached = await getCachedSessionHistoryTreeSnapshot(
						logPath,
						sessionId,
						cursor
					);
					if (cached !== undefined) {
						return pageSessionHistoryTree(
							cached,
							cached.readPoint,
							cursor.afterSequence,
							limit
						);
					}
				}
				const { state } = await sessionLog.readForHistoryTree(sessionId);
				const snapshot = resolveSessionHistoryTreeSnapshot(
					state,
					sessionId,
					cursor
				);
				const tree = buildSessionHistoryTreeEntries(
					state,
					sessionId,
					snapshot.snapshotSequence
				);
				const page = pageSessionHistoryTree(
					tree,
					snapshot.readPoint,
					snapshot.afterSequence,
					limit
				);
				if (page.nextCursor !== undefined) {
					await cacheSessionHistoryTreeSnapshot(logPath, snapshot, tree);
				}
				return page;
			});
		});
	};

	const readPluginSessionHistoryPage = async (
		sessionId: SessionId,
		pluginId: string,
		options: SessionPageOptions = {}
	): Promise<PluginSessionHistoryPage> => {
		validatePluginSessionHistoryPluginId(pluginId);
		const page = await readSessionHistoryTreePage(sessionId, options);
		const selectedEntries = page.entries.filter(
			(entry) =>
				entry.kind === "plugin-entry" &&
				entry.pluginId === pluginId &&
				entry.selectedPath
		);
		if (selectedEntries.length === 0) {
			return {
				entries: [],
				...omitUndefined({ nextCursor: page.nextCursor }),
				readPoint: page.readPoint,
			};
		}
		const state = (await (await projected.open(sessionId)).atHeadState()).state;
		const envelopesByEntryId = new Map<string, SessionLogEnvelope>();
		for (const { envelope } of state.entries) {
			if (envelope.type === "plugin.entry-appended") {
				envelopesByEntryId.set(
					String(envelope.payload.historyEntryId),
					envelope
				);
			}
		}
		const entries: PluginSessionHistoryEntry[] = selectedEntries.map(
			(entry) => {
				if (entry.kind !== "plugin-entry") {
					throw new Error("Plugin history page contained a non-Plugin entry.");
				}
				const envelope = envelopesByEntryId.get(entry.id);
				if (
					envelope === undefined ||
					envelope.payload.pluginId !== pluginId ||
					envelope.payload.entryType !== entry.type
				) {
					throw new SessionLogError(
						"session_log_corrupt",
						sessionId,
						"Plugin history tree entry has no matching append event."
					);
				}
				return {
					createdAt: entry.createdAt,
					id: entry.id,
					parentEntryId: entry.parentEntryId,
					payload: copyPluginSessionHistoryPayload(envelope.payload.payload),
					sequence: entry.sequence,
					type: entry.type,
				};
			}
		);
		return {
			entries,
			...omitUndefined({ nextCursor: page.nextCursor }),
			readPoint: page.readPoint,
		};
	};
	const readSessionHistoryPath = async (
		sessionId: SessionId
	): Promise<SessionHistoryPath> => {
		await projected.reconcileDeleted();
		const handle = await projected.open(sessionId);
		const view = await handle.atHead();
		return await withSessionCatalogLifecycleGate(logRoot, async () => {
			assertSessionHistoryWorkspaceBinding(sessionId, undefined);
			await checkDeletedMarker(sessionId);
			return await view.read(async () => {
				const { state } = await sessionLog.readForHistoryTree(sessionId);
				const tree = buildSessionHistoryTreeEntries(
					state,
					sessionId,
					state.nextSequence - 1
				);
				const entries = tree.entries.filter(({ selectedPath }) => selectedPath);
				const submissionUpdates = new Map(
					entries.flatMap((entry) =>
						entry.kind === "submission-status"
							? [
									[
										`${entry.recordId}\0${entry.messageId}\0${entry.submissionId}`,
										entry,
									],
								]
							: []
					)
				);
				const records = entries.flatMap((entry) =>
					entry.kind === "record"
						? [
								{
									...entry.record,
									messages: entry.record.messages.map((message) => {
										const submissionId = message.metadata?.submissionId;
										if (message.role !== "user" || submissionId === undefined) {
											return message;
										}
										const status = submissionUpdates.get(
											`${entry.recordId}\0${message.id}\0${submissionId}`
										);
										return status === undefined
											? message
											: withSubmissionStatus(message, {
													failure: status.failure,
													status: status.status,
													submissionId: toSubmissionId(status.submissionId),
												});
									}),
								},
							]
						: []
				);
				const compactionIds = new Set(
					entries.flatMap((entry) =>
						entry.kind === "compaction" ? [entry.compactionId] : []
					)
				);
				const contextEditOperationIds = new Set(
					entries.flatMap((entry) =>
						entry.kind === "context-edit" ? [entry.operationId] : []
					)
				);
				const [allCompactions, allContextEdits] = await Promise.all([
					projectionStore.getCompactions(sessionId),
					projectionStore.getSessionContextEdits(sessionId),
				]);
				let model = state.entries.find(
					({ envelope }) => envelope.type === "session.created"
				)?.envelope.payload.model as ProviderModelSelection | undefined;
				let thinkingLevel = state.entries.find(
					({ envelope }) => envelope.type === "session.created"
				)?.envelope.payload.thinkingLevel as ThinkingLevel | undefined;
				for (const entry of entries) {
					if (entry.kind !== "record") {
						continue;
					}
					model = entry.sessionModel ?? model;
					thinkingLevel = entry.sessionThinkingLevel ?? thinkingLevel;
				}
				return {
					activeLeafId: tree.activeLeafId,
					compactions: allCompactions.filter(({ id }) => compactionIds.has(id)),
					contextEdits: allContextEdits.filter(({ operationId }) =>
						contextEditOperationIds.has(operationId)
					),
					entries,
					historyGeneration: tree.historyGeneration,
					model,
					records,
					thinkingLevel,
				};
			});
		});
	};

	const runForkSession = async (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint,
		operationId: string,
		sourceWriterAlreadyHeld: boolean
	): Promise<SessionForkResult> => {
		if (!isValidSessionLogIdentifier(operationId)) {
			throw new SessionForkError(
				"session_operation_conflict",
				"Session fork operation ID is invalid.",
				sourceSessionId,
				operationId
			);
		}
		const sourceKey = await lockKey(logRoot, sourceSessionId);
		if (heldWriterKeys.has(sourceKey) !== sourceWriterAlreadyHeld) {
			throw new SessionForkError(
				"session_busy",
				sourceWriterAlreadyHeld
					? "Session Host does not hold the source writer."
					: "Session cannot be forked while its Session Host owns the writer.",
				sourceSessionId,
				operationId
			);
		}
		const operationDigest = sessionLogOperationDigest("session.forked", {
			checkpointRecordId: checkpoint.recordId,
			sourceSessionId,
		});
		return sessionLog.withForkQueue(sourceSessionId, operationId, async () => {
			const existingIntent = await withSessionCatalogLifecycleGate(
				logRoot,
				async () => {
					const existing = await sessionLog.readForkIntent(
						operationId,
						sourceSessionId
					);
					if (
						existing !== undefined &&
						(existing.sourceSessionId !== sourceSessionId ||
							existing.checkpointRecordId !== checkpoint.recordId ||
							existing.operationDigest !== operationDigest)
					) {
						throw new SessionForkError(
							"session_operation_conflict",
							"Session fork operation ID was reused for a different source or checkpoint.",
							sourceSessionId,
							operationId
						);
					}
					return existing;
				}
			);
			let operationIntent = existingIntent;
			let targetSessionId = toSessionId(
				operationIntent?.targetSessionId ?? randomUUIDv7()
			);
			const forkOperationLogId = `fork-${operationIdFileStem(operationId).slice(0, 40)}`;
			let targetLogPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				targetSessionId
			);
			const reconcilePublishedForkCreation = async (
				createdEntry: SessionLogEntry,
				publishedBytes: Uint8Array
			): Promise<void> => {
				const createdOperationId = `create-${targetSessionId}`;
				const createdIntent: SessionWriteIntent &
					Readonly<{ timestamp: string }> = {
					expectedOffset: 0,
					operationDigest: creationDigest(createdEntry.envelope.payload),
					operationId: createdOperationId,
					sequence: 1,
					sessionId: targetSessionId,
					timestamp: createdEntry.envelope.timestamp,
					type: "session.created",
					workspaceId: projection.workspaceId,
				};
				const pendingIntent = await readSessionWriteIntent(
					logRoot,
					targetSessionId,
					fileIo
				);
				if (pendingIntent !== undefined) {
					assertSameSessionWriteIntent(
						pendingIntent,
						createdIntent,
						targetSessionId
					);
				}
				try {
					await syncAndVerifyLogPrefix(
						targetLogPath,
						publishedBytes,
						targetSessionId,
						fileIo
					);
					await ensureDurableReceipt(
						logRoot,
						targetSessionId,
						createdEntry,
						fileIo
					);
					if (pendingIntent !== undefined) {
						await sessionLog.clearWriteIntent(createdIntent);
					}
				} catch (error) {
					throw indeterminateLogWriteError(
						targetSessionId,
						createdIntent,
						error
					);
				}
			};
			const publishedForkProjectionReady = async (): Promise<boolean> => {
				try {
					await (await projected.open(targetSessionId)).atHead();
					return true;
				} catch (error) {
					if (!isCode(error, "session_projection_blocked")) {
						throw error;
					}
					return false;
				}
			};
			const returnPublishedFork = async (
				state: SessionLogState,
				publishedBytes: Uint8Array
			): Promise<SessionForkResult> => {
				const { createdEntry, forked, forkedEntry } =
					requirePublishedForkEntries(
						state,
						sourceSessionId,
						checkpoint.recordId,
						operationId,
						forkOperationLogId
					);
				await reconcilePublishedForkCreation(createdEntry, publishedBytes);
				await checkDeletedMarker(targetSessionId);
				if (projection.isBoundToAnotherWorkspace(targetSessionId)) {
					throw new SessionForkError(
						"session_operation_conflict",
						"Published fork belongs to another Workspace.",
						sourceSessionId,
						operationId
					);
				}
				if (!projection.isBoundToWorkspace(targetSessionId)) {
					await withSessionCatalogLifecycleGate(logRoot, async () => {
						await checkDeletedMarker(targetSessionId);
						projection.bindSessionToWorkspace(targetSessionId);
					});
				}
				const projectionReady = await publishedForkProjectionReady();
				return {
					created: false,
					id: targetSessionId,
					checkpoint: {
						recordId: checkpoint.recordId,
						sequence: forked.sourceSequence,
						turnId: toAgentTurnId(forked.sourceTurnId),
					},
					writeOutcome: toForkReceipt(
						forkedEntry,
						operationId,
						projectionReady ? "ready" : "blocked"
					),
				};
			};
			if (operationIntent !== undefined) {
				const existingTarget = await readExistingSessionLog(
					targetLogPath,
					targetSessionId
				);
				if (existingTarget !== undefined) {
					return returnPublishedFork(
						existingTarget.state,
						existingTarget.bytes
					);
				}
			}

			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the held source writer spans cut validation, prefix remapping, and staged publication so no source mutation can invalidate the durable fork boundary
			const forkWithSourceWriter = async (): Promise<SessionForkResult> => {
				const currentIntent = await withSessionCatalogLifecycleGate(
					logRoot,
					() => readSessionForkIntent(logRoot, operationId, sourceSessionId)
				);
				if (
					currentIntent !== undefined &&
					(currentIntent.sourceSessionId !== sourceSessionId ||
						currentIntent.checkpointRecordId !== checkpoint.recordId ||
						currentIntent.operationDigest !== operationDigest)
				) {
					throw new SessionForkError(
						"session_operation_conflict",
						"Session fork operation ID was reused for a different source or checkpoint.",
						sourceSessionId,
						operationId
					);
				}
				operationIntent = currentIntent;
				if (currentIntent !== undefined) {
					targetSessionId = toSessionId(currentIntent.targetSessionId);
					targetLogPath = resolveSessionLogFilePath(
						await fs.realpath(logRoot),
						targetSessionId
					);
					const publishedTarget = await readExistingSessionLog(
						targetLogPath,
						targetSessionId
					);
					if (publishedTarget !== undefined) {
						return returnPublishedFork(
							publishedTarget.state,
							publishedTarget.bytes
						);
					}
				}
				await projected.open(sourceSessionId);
				await assertSessionWritable(sourceSessionId);
				const sourceState = (
					await (await projected.open(sourceSessionId)).atHeadState()
				).state;
				const checkpointEntry = sourceState.entries.find(
					(entry) =>
						recordFromSessionLogEntry(entry)?.id === checkpoint.recordId
				);
				if (checkpointEntry === undefined) {
					throw new SessionForkError(
						"session_checkpoint_invalid",
						"Checkpoint Record was not found in the source Session.",
						sourceSessionId,
						operationId
					);
				}
				const checkpointHistoryEntry = buildSessionHistoryTreeEntries(
					sourceState,
					sourceSessionId,
					sourceState.nextSequence - 1
				).entries.find(
					(entry) =>
						entry.kind === "record" && entry.recordId === checkpoint.recordId
				);
				if (checkpointHistoryEntry === undefined) {
					throw new SessionForkError(
						"session_checkpoint_invalid",
						"Checkpoint Record has no history entry in the source Session.",
						sourceSessionId,
						operationId
					);
				}
				const sourcePathEntryIds = sessionHistoryPathToEntryFromLog(
					sourceState,
					sourceSessionId,
					checkpointHistoryEntry.id,
					checkpointEntry.envelope.sequence
				);
				const sourcePrefixEntries = sourceState.entries.filter(
					({ envelope }) => {
						if (
							envelope.type === "session.created" ||
							envelope.type === "session.forked"
						) {
							return true;
						}
						if (envelope.sequence > checkpointEntry.envelope.sequence) {
							return false;
						}
						if (
							envelope.type === "session.metadata-updated" ||
							envelope.type === "usage.committed"
						) {
							return true;
						}
						return (
							isSessionHistoryEntryEventType(envelope.type) &&
							sourcePathEntryIds.has(
								toSessionHistoryEntryId(String(envelope.payload.historyEntryId))
							)
						);
					}
				);
				const sourceRecords = sourcePrefixEntries.flatMap((entry) => {
					const record = recordFromSessionLogEntry(entry);
					return record === undefined ? [] : [record];
				});
				const checkpointAssessment = assessSessionForkCheckpoint(
					sourceRecords,
					checkpoint.recordId
				);
				if (checkpointAssessment.kind === "invalid") {
					throw new SessionForkError(
						"session_checkpoint_invalid",
						checkpointAssessment.reason,
						sourceSessionId,
						operationId
					);
				}
				const checkpointRecord = checkpointAssessment.record;
				const sourceCreatedEntry = sourcePrefixEntries.find(
					({ envelope }) => envelope.type === "session.created"
				);
				if (sourceCreatedEntry?.envelope.type !== "session.created") {
					throw new SessionForkError(
						"session_checkpoint_invalid",
						"Source Session creation checkpoint is missing.",
						sourceSessionId,
						operationId
					);
				}
				const sourceCompactions = sourcePrefixEntries.flatMap((entry) =>
					entry.envelope.type === "compaction.committed"
						? [parseSessionCompactionPayload(entry.envelope.payload)]
						: []
				);
				const sourcePathCompactionIds = new Set(
					sourceCompactions.map(({ id }) => String(id))
				);
				const sourcePathEntryIdStrings = new Set(
					[...sourcePathEntryIds].map(String)
				);
				const selectedPathUsageEntries = sourcePrefixEntries.filter((entry) =>
					isSessionBundleBranchUsageSourceEntry(
						entry,
						sourcePathEntryIdStrings,
						sourcePathCompactionIds
					)
				);
				const inheritedUsage = filterSessionUsageToSelectedPath(
					inheritedUsageAtFork(
						selectedPathUsageEntries,
						sourceRecords,
						sourceSessionId
					),
					sourceRecords,
					sourcePathCompactionIds
				);
				const identityMap = createSessionForkIdentityMap(
					targetSessionId,
					sourceRecords,
					sourceCompactions.map(({ id }) => id)
				);
				const copiedSourceCompactionIds = new Set<string>();
				const remappedCompactions = new Map<string, SessionCompactionPayload>();
				for (const compaction of sourceCompactions) {
					const remapped = remapForkCompactionPayload(
						compaction,
						remappedCompactions.size + 1,
						identityMap,
						copiedSourceCompactionIds
					);
					if (remapped !== undefined) {
						remappedCompactions.set(compaction.id, remapped);
						copiedSourceCompactionIds.add(compaction.id);
					}
				}
				const remappedRecords = new Map(
					sourceRecords.map((record) => [
						record.id,
						remapForkSessionRecord(record, identityMap),
					])
				);
				const targetCheckpointRecord = remappedRecords.get(checkpointRecord.id);
				const targetCheckpointMessage = targetCheckpointRecord?.messages[0];
				const targetCheckpointRecordId = identityMap.records.get(
					checkpointRecord.id
				);
				const targetCheckpointTurnId = identityMap.turns.get(
					checkpointRecord.turnId
				);
				const targetCheckpointMessageId = identityMap.messages.get(
					checkpointRecord.messages[0]?.id ?? ""
				);
				if (
					targetCheckpointRecord === undefined ||
					targetCheckpointMessage === undefined ||
					targetCheckpointRecordId === undefined ||
					targetCheckpointTurnId === undefined ||
					targetCheckpointMessageId === undefined
				) {
					throw new SessionForkError(
						"session_checkpoint_invalid",
						"Terminal assistant checkpoint identities could not be remapped.",
						sourceSessionId,
						operationId
					);
				}
				const sourceInitialRecord = sourceCreatedEntry.envelope.payload
					.initialRecord as SessionRecord | undefined;
				const targetInitialRecord =
					sourceInitialRecord === undefined
						? undefined
						: remappedRecords.get(sourceInitialRecord.id);
				const pendingTargetIntent = await readSessionWriteIntent(
					logRoot,
					targetSessionId,
					fileIo
				);
				const createdAt =
					pendingTargetIntent?.type === "session.created" &&
					pendingTargetIntent.timestamp !== undefined
						? pendingTargetIntent.timestamp
						: new Date().toISOString();
				const {
					activeLeafId: _sourceActiveLeafId,
					initialHistoryEntryId: _sourceHistoryEntryId,
					initialRecord: _sourceInitialRecord,
					...sourceCreationPayload
				} = sourceCreatedEntry.envelope.payload;
				const targetInitialHistoryEntryId =
					targetInitialRecord === undefined
						? undefined
						: sessionHistoryEntryIdForRecord(
								targetSessionId,
								targetInitialRecord.id
							);
				let activeLeafId: string | null = targetInitialHistoryEntryId ?? null;
				const creationPayload = {
					...sourceCreationPayload,
					activeLeafId,
					createdAt,
					...omitUndefined({
						initialHistoryEntryId: targetInitialHistoryEntryId,
						initialRecord: targetInitialRecord,
					}),
				};
				const forkPayload = {
					sourceLogId: sourceState.logId,
					sourceMessageId: checkpointRecord.messages[0]?.id ?? "",
					sourceRecordId: checkpointRecord.id,
					sourceSequence: checkpointEntry.envelope.sequence,
					sourceSessionId,
					sourceTurnId: checkpointRecord.turnId,
					targetMessageId: targetCheckpointMessageId,
					targetRecordId: targetCheckpointRecordId,
					targetTurnId: targetCheckpointTurnId,
					inheritedRecordIds: sourceRecords.map((record) =>
						String(identityMap.records.get(record.id))
					),
					inheritedCompactionIds: [...remappedCompactions.values()].map(
						({ id }) => String(id)
					),
					inheritedSubmissions: inheritedForkSubmissionsAtCut(
						sourcePrefixEntries,
						sourceRecords,
						identityMap,
						sourceSessionId,
						operationId
					),
					inheritedUsage: remapForkUsageTurnIds(inheritedUsage, identityMap),
				};
				const logLines: Uint8Array[] = [];
				let nextSequence = 0;
				let nextOffset = 0;
				let previousHash: string | null = null;
				const appendLine = (envelope: SessionLogEnvelope): void => {
					const line = encodeSessionLogLine(envelope);
					logLines.push(line);
					nextOffset += line.byteLength;
					nextSequence += 1;
					previousHash = envelope.entryHash;
				};
				const header = createSessionLogHeader(
					targetSessionId,
					randomUUIDv7(),
					createdAt
				);
				appendLine(header);
				const createdOperationId = `create-${targetSessionId}`;
				const createdEnvelope = createSessionLogEvent({
					operationId: createdOperationId,
					payload: creationPayload,
					previousHash,
					sequence: nextSequence,
					sessionId: targetSessionId,
					timestamp: createdAt,
					type: "session.created",
				});
				appendLine(createdEnvelope);
				const forkEnvelope = createSessionLogEvent({
					operationId: forkOperationLogId,
					payload: forkPayload,
					previousHash,
					sequence: nextSequence,
					sessionId: targetSessionId,
					timestamp: createdAt,
					type: "session.forked",
				});
				appendLine(forkEnvelope);
				for (const entry of sourcePrefixEntries) {
					if (entry.envelope.sequence <= 1) {
						continue;
					}
					if (entry.envelope.type === "plugin.entry-appended") {
						const operationId = `fork-plugin-history-${entry.envelope.sequence}`;
						const historyEntryId = sessionHistoryEntryIdForOperation(
							targetSessionId,
							operationId
						);
						appendLine(
							createSessionLogEvent({
								operationId,
								payload: {
									...entry.envelope.payload,
									activeLeafId: historyEntryId,
									historyEntryId,
									parentEntryId: activeLeafId,
								},
								previousHash,
								sequence: nextSequence,
								sessionId: targetSessionId,
								timestamp: entry.envelope.timestamp,
								type: "plugin.entry-appended",
							})
						);
						activeLeafId = historyEntryId;
						continue;
					}
					if (
						entry.envelope.type === "plugin.state-replaced" ||
						entry.envelope.type === "plugin.state-deleted"
					) {
						const operationId = `fork-plugin-state-${entry.envelope.sequence}`;
						const historyEntryId = sessionHistoryEntryIdForOperation(
							targetSessionId,
							operationId
						);
						appendLine(
							createSessionLogEvent({
								operationId,
								payload: {
									...entry.envelope.payload,
									activeLeafId: historyEntryId,
									historyEntryId,
									parentEntryId: activeLeafId,
								},
								previousHash,
								sequence: nextSequence,
								sessionId: targetSessionId,
								timestamp: entry.envelope.timestamp,
								type: entry.envelope.type,
							})
						);
						activeLeafId = historyEntryId;
						continue;
					}
					const sourceRecord = recordFromSessionLogEntry(entry);
					if (
						sourceRecord !== undefined &&
						sourceRecord.id !== sourceInitialRecord?.id
					) {
						const record = remappedRecords.get(sourceRecord.id);
						if (record === undefined) {
							throw new SessionForkError(
								"session_checkpoint_invalid",
								"A source Session Record could not be remapped.",
								sourceSessionId,
								operationId
							);
						}
						const sourcePayload = entry.envelope.payload;
						const historyEntryId = sessionHistoryEntryIdForRecord(
							targetSessionId,
							record.id
						);
						const recordEnvelope = createSessionLogEvent({
							operationId: `record-${record.id}`,
							payload: {
								activeLeafId: historyEntryId,
								historyEntryId,
								parentEntryId: activeLeafId,
								record,
								...omitUndefined({
									sessionModel: sourcePayload.sessionModel,
									sessionThinkingLevel: sourcePayload.sessionThinkingLevel,
								}),
							},
							previousHash,
							sequence: nextSequence,
							sessionId: targetSessionId,
							timestamp: entry.envelope.timestamp,
							type: "record.committed",
						});
						appendLine(recordEnvelope);
						activeLeafId = historyEntryId;
						continue;
					}
					if (entry.envelope.type === "submission.status-updated") {
						const status = parseSessionSubmissionStatusPayload(
							entry.envelope.payload
						);
						const recordId = identityMap.records.get(status.recordId);
						const messageId = identityMap.messages.get(status.messageId);
						const submissionId = identityMap.submissions.get(
							status.submissionId
						);
						if (
							recordId !== undefined &&
							messageId !== undefined &&
							submissionId !== undefined
						) {
							const statusOperationId = `fork-submission-status-${entry.envelope.sequence}`;
							const historyEntryId = sessionHistoryEntryIdForOperation(
								targetSessionId,
								statusOperationId
							);
							appendLine(
								createSessionLogEvent({
									operationId: statusOperationId,
									payload: {
										activeLeafId: historyEntryId,
										historyEntryId,
										messageId,
										parentEntryId: activeLeafId,
										recordId,
										status: "processed",
										submissionId,
									},
									previousHash,
									sequence: nextSequence,
									sessionId: targetSessionId,
									timestamp: entry.envelope.timestamp,
									type: "submission.status-updated",
								})
							);
							activeLeafId = historyEntryId;
						}
						continue;
					}
					if (entry.envelope.type === "compaction.committed") {
						const sourceCompaction = parseSessionCompactionPayload(
							entry.envelope.payload
						);
						const compaction = remappedCompactions.get(sourceCompaction.id);
						if (compaction !== undefined) {
							const operationId = `compaction-${compaction.id}`;
							const historyEntryId = sessionHistoryEntryIdForOperation(
								targetSessionId,
								operationId
							);
							appendLine(
								createSessionLogEvent({
									operationId,
									payload: {
										...compaction,
										activeLeafId: historyEntryId,
										historyEntryId,
										parentEntryId: activeLeafId,
									},
									previousHash,
									sequence: nextSequence,
									sessionId: targetSessionId,
									timestamp: entry.envelope.timestamp,
									type: "compaction.committed",
								})
							);
							activeLeafId = historyEntryId;
						}
						continue;
					}
					if (entry.envelope.type === "context.edited") {
						const edit = parseSessionContextEditPayload(entry.envelope.payload);
						const targetId = identityMap.messages.get(edit.targetId);
						if (targetId !== undefined) {
							const editOperationId = isFailedAttemptContextEdit(
								edit.operationId
							)
								? `${FAILED_ATTEMPT_CONTEXT_EDIT_OPERATION_PREFIX}fork-${entry.envelope.sequence}`
								: `fork-context-${entry.envelope.sequence}`;
							const historyEntryId = sessionHistoryEntryIdForOperation(
								targetSessionId,
								editOperationId
							);
							appendLine(
								createSessionLogEvent({
									operationId: editOperationId,
									payload: {
										...edit,
										activeLeafId: historyEntryId,
										historyEntryId,
										operationId: editOperationId,
										parentEntryId: activeLeafId,
										targetId,
									},
									previousHash,
									sequence: nextSequence,
									sessionId: targetSessionId,
									timestamp: entry.envelope.timestamp,
									type: "context.edited",
								})
							);
							activeLeafId = historyEntryId;
						}
						continue;
					}
					if (entry.envelope.type === "session.metadata-updated") {
						appendLine(
							createSessionLogEvent({
								operationId: `fork-metadata-${entry.envelope.sequence}`,
								payload: entry.envelope.payload,
								previousHash,
								sequence: nextSequence,
								sessionId: targetSessionId,
								timestamp: entry.envelope.timestamp,
								type: "session.metadata-updated",
							})
						);
					}
				}
				const logBytes = new Uint8Array(nextOffset);
				let byteOffset = 0;
				for (const line of logLines) {
					logBytes.set(line, byteOffset);
					byteOffset += line.byteLength;
				}
				const targetState = decodeSessionLog(targetSessionId, logBytes);
				const createdEntry = targetState.entries[1];
				if (createdEntry === undefined) {
					throw new SessionForkError(
						"session_checkpoint_invalid",
						"Staged fork is missing its creation checkpoint.",
						sourceSessionId,
						operationId
					);
				}
				const createdIntent: SessionWriteIntent &
					Readonly<{ timestamp: string }> = {
					expectedOffset: 0,
					operationDigest: creationDigest(creationPayload),
					operationId: createdOperationId,
					sequence: 1,
					sessionId: targetSessionId,
					timestamp: createdAt,
					type: "session.created",
					workspaceId: projection.workspaceId,
				};
				if (pendingTargetIntent !== undefined) {
					assertSameSessionWriteIntent(
						pendingTargetIntent,
						createdIntent,
						targetSessionId
					);
				}
				const canonicalRoot = await fs.realpath(logRoot);
				const forkIntentCandidate: SessionForkIntent = {
					checkpointRecordId: checkpoint.recordId,
					operationDigest,
					operationId,
					sourceSessionId,
					targetSessionId,
					version: 1,
				};
				let forkIntentCreated = false;
				let publicationAttempted = false;
				let published = false;
				let staged: StagedSessionLog | undefined;
				try {
					let durableForkIntent = operationIntent;
					if (durableForkIntent === undefined) {
						durableForkIntent = await withSessionCatalogLifecycleGate(
							canonicalRoot,
							async () => {
								const existing = await sessionLog.readForkIntent(
									operationId,
									sourceSessionId
								);
								if (
									existing !== undefined &&
									(existing.sourceSessionId !== sourceSessionId ||
										existing.checkpointRecordId !== checkpoint.recordId ||
										existing.operationDigest !== operationDigest ||
										existing.targetSessionId !== targetSessionId)
								) {
									throw new SessionForkError(
										"session_operation_conflict",
										"Session fork operation ID was reused for a different source or checkpoint.",
										sourceSessionId,
										operationId
									);
								}
								if (existing !== undefined) {
									return existing;
								}
								forkIntentCreated = true;
								const created = await sessionLog.writeForkIntent(
									forkIntentCandidate,
									sourceSessionId
								);
								if (!Bun.deepEquals(created, forkIntentCandidate, true)) {
									throw new SessionForkError(
										"session_operation_conflict",
										"Session fork operation ID was reused for a different source or checkpoint.",
										sourceSessionId,
										operationId
									);
								}
								return created;
							}
						);
					}
					if (durableForkIntent.targetSessionId !== targetSessionId) {
						throw new SessionForkError(
							"session_operation_conflict",
							"Session fork operation ID was reused for a different target.",
							sourceSessionId,
							operationId
						);
					}
					const stagedLog = await stageSessionLog(
						canonicalRoot,
						targetSessionId,
						createdOperationId,
						logBytes,
						fileIo
					);
					staged = stagedLog;
					await sessionLog.writeIntent(createdIntent);
					await withSessionCatalogLifecycleGate(canonicalRoot, async () => {
						await checkDeletedMarker(targetSessionId);
						if (projection.isBoundToAnotherWorkspace(targetSessionId)) {
							throw new SessionForkError(
								"session_operation_conflict",
								"Fork target belongs to another Workspace.",
								sourceSessionId,
								operationId
							);
						}
						publicationAttempted = true;
						await sessionLog.publishStaged(stagedLog, targetLogPath, () => {
							published = true;
						});
						projection.bindSessionToWorkspace(targetSessionId);
					});
					const publishedLog = await readLog(targetLogPath, targetSessionId);
					await syncAndVerifyLogPrefix(
						targetLogPath,
						publishedLog.bytes,
						targetSessionId,
						fileIo
					);
					try {
						await ensureDurableReceipt(
							logRoot,
							targetSessionId,
							createdEntry,
							fileIo
						);
						await sessionLog.clearWriteIntent(createdIntent);
					} catch (error) {
						throw indeterminateLogWriteError(
							targetSessionId,
							createdIntent,
							error
						);
					}
					let projectionReady = true;
					try {
						projection.projectEntries(
							targetSessionId,
							publishedLog.state.entries,
							publishedLog.state,
							projection.getCursor(targetSessionId)
						);
					} catch {
						projectionReady = sessionProjectionMatchesState(
							projection.getCursor(targetSessionId),
							publishedLog.state,
							projection.getMaintenanceState().generation
						);
					}
					const forkedEntry = publishedLog.state.entries.find(
						({ envelope }) =>
							envelope.type === "session.forked" &&
							envelope.operationId === forkOperationLogId
					);
					if (forkedEntry?.envelope.type !== "session.forked") {
						throw new SessionLogError(
							"session_log_corrupt",
							targetSessionId,
							"Published fork is missing its provenance checkpoint.",
							{ operationId }
						);
					}
					return {
						created: true,
						id: targetSessionId,
						checkpoint: {
							recordId: checkpointRecord.id,
							sequence: checkpointEntry.envelope.sequence,
							turnId: checkpointRecord.turnId,
						},
						writeOutcome: toForkReceipt(
							forkedEntry,
							operationId,
							projectionReady ? "ready" : "blocked"
						),
					};
				} catch (error) {
					if (published) {
						if (
							error instanceof SessionLogError &&
							error.code === "session_operation_conflict"
						) {
							throw error;
						}
						throw indeterminateLogWriteError(
							targetSessionId,
							createdIntent,
							error
						);
					}
					if (forkIntentCreated && !publicationAttempted) {
						try {
							await sessionLog.clearWriteIntent(createdIntent);
							await withSessionCatalogLifecycleGate(canonicalRoot, () =>
								clearSessionForkIntent(
									logRoot,
									forkIntentCandidate,
									sourceSessionId,
									fileIo
								)
							);
						} catch (cleanupError) {
							throw new SessionLogError(
								"session_log_write_indeterminate",
								targetSessionId,
								"Fork failed before publication, but its operation intent could not be cleared.",
								{ cause: cleanupError, operationId }
							);
						}
					}
					throw error;
				} finally {
					if (staged !== undefined) {
						await fs
							.rm(staged.filePath, { force: true })
							.catch(() => undefined);
					}
				}
			};
			return sourceWriterAlreadyHeld
				? await forkWithSourceWriter()
				: await withTemporaryWriter(sourceSessionId, forkWithSourceWriter);
		});
	};
	const forkSession: SessionLifecycle["forkSession"] = (
		sourceSessionId,
		checkpoint,
		operationId
	) => runForkSession(sourceSessionId, checkpoint, operationId, false);
	const forkSessionWithHeldWriter: SessionLifecycle["forkSessionWithHeldWriter"] =
		(sourceSessionId, checkpoint, operationId) =>
			runForkSession(sourceSessionId, checkpoint, operationId, true);

	const getSessionForkProvenance: SessionLifecycle["getSessionForkProvenance"] =
		async (sessionId) => {
			await (await projected.open(sessionId)).atHead();
			return withSessionCatalogLifecycleGate(logRoot, async () => {
				await checkDeletedMarker(sessionId);
				const { state } = await readLog(
					resolveSessionLogFilePath(await fs.realpath(logRoot), sessionId),
					sessionId
				);
				const forkEntry = state.entries.find(
					({ envelope }) => envelope.type === "session.forked"
				);
				if (forkEntry?.envelope.type !== "session.forked") {
					return;
				}
				const provenance = toSessionForkProvenance(forkEntry.envelope.payload);
				if (!projection.isBoundToWorkspace(provenance.sourceSessionId)) {
					return { ...provenance, sourceAvailability: "unavailable" };
				}
				try {
					await checkDeletedMarker(provenance.sourceSessionId);
					const sourceLog = await sessionLog.readWithRetry(
						provenance.sourceSessionId
					);
					return {
						...provenance,
						sourceAvailability:
							sourceLog.state.logId === provenance.sourceLogId
								? "available"
								: "unavailable",
					};
				} catch {
					return { ...provenance, sourceAvailability: "unavailable" };
				}
			});
		};
	const getOrCreateSessionForkActionId: SessionLifecycle["getOrCreateSessionForkActionId"] =
		async (sourceSessionId, checkpoint) =>
			withSessionCatalogLifecycleGate(logRoot, async () => {
				const existing = await sessionLog.readForkAction(
					sourceSessionId,
					checkpoint
				);
				if (existing !== undefined) {
					return existing.operationId;
				}
				const candidate: SessionForkAction = {
					checkpointRecordId: checkpoint.recordId,
					operationId: `ui-fork-${randomUUIDv7()}`,
					sourceSessionId,
					version: 1,
				};
				const created = await sessionLog.writeForkAction(candidate, checkpoint);
				if (
					created.sourceSessionId !== sourceSessionId ||
					created.checkpointRecordId !== checkpoint.recordId
				) {
					throw new SessionForkError(
						"session_operation_conflict",
						"Session fork action identity conflicts with its source checkpoint.",
						sourceSessionId,
						created.operationId
					);
				}
				return created.operationId;
			});
	const completeSessionForkAction: SessionLifecycle["completeSessionForkAction"] =
		(sourceSessionId, checkpoint, operationId) =>
			withSessionCatalogLifecycleGate(logRoot, () =>
				clearSessionForkAction(
					logRoot,
					sourceSessionId,
					checkpoint,
					operationId,
					fileIo
				)
			);

	const getSessionStatistics: SessionCatalog["getSessionStatistics"] = async (
		sessionId,
		options: SessionStatisticsOptions = {}
	): Promise<SessionStatistics> => {
		const requestedReadPoint =
			options.readPoint === undefined
				? undefined
				: decodeSessionHistoryReadPointToken(options.readPoint);
		const handle = await projected.open(sessionId);
		const view =
			requestedReadPoint === undefined
				? await handle.atHead()
				: await handle.at(requestedReadPoint);
		return withSessionCatalogLifecycleGate(logRoot, async () => {
			assertSessionStatisticsWorkspaceBinding(
				sessionId,
				requestedReadPoint !== undefined
			);
			try {
				await checkDeletedMarker(sessionId);
			} catch (error) {
				if (
					requestedReadPoint !== undefined &&
					isCode(error, "session_deleted")
				) {
					throw new SessionPaginationError(
						"cursor_expired",
						"Session statistics read point expired because the Session was deleted."
					);
				}
				throw error;
			}
			return await view.read(async () => {
				const statisticsProjection =
					projectionStore.readSessionStatisticsProjection(
						sessionId,
						requestedReadPoint,
						options.turnId
					);
				const forkProvenance =
					statisticsProjection.forkProvenance === undefined
						? undefined
						: toSessionForkProvenance(statisticsProjection.forkProvenance);
				const { state } = await sessionLog.read(sessionId);
				const historyTree = buildSessionHistoryTreeEntries(
					state,
					sessionId,
					statisticsProjection.readPoint.readPointSequence
				);
				const selectedPath: SessionStatisticsHistoryPath = {
					compactionIds: new Set(
						historyTree.entries.flatMap((entry) =>
							entry.kind === "compaction" && entry.selectedPath
								? [String(entry.compactionId)]
								: []
						)
					),
					recordIds: new Set(
						historyTree.entries.flatMap((entry) =>
							entry.kind === "record" && entry.selectedPath
								? [String(entry.recordId)]
								: []
						)
					),
				};
				return buildSessionStatistics({
					compactions: statisticsProjection.compactions,
					inheritedCompactionIds: new Set(
						forkProvenance?.inheritedCompactionIds.map(String) ?? []
					),
					inheritedRecordIds: new Set(
						forkProvenance?.inheritedRecordIds.map(String) ?? []
					),
					inheritedUsage: forkProvenance?.inheritedUsage,
					readPoint: encodeSessionPageToken(statisticsProjection.readPoint),
					records: statisticsProjection.records,
					selectedPath,
					sessionId,
					summary: statisticsProjection.summary,
					...(options.turnId === undefined ? {} : { turnId: options.turnId }),
					usageEntries: statisticsProjection.usageEntries,
				});
			});
		});
	};

	const reconcileDeletedSession = async (
		sessionId: SessionId
	): Promise<SessionCatalogIssue | undefined> => {
		const outcome = await deleteSession(sessionId);
		if (outcome.kind === "committed" && outcome.projection === "ready") {
			return;
		}
		if (outcome.kind === "cleanup-pending") {
			return catalogIssue(
				sessionId,
				Object.assign(new Error(outcome.message), { code: outcome.code })
			);
		}
		const failure =
			outcome.kind === "committed"
				? {
						code: "session_projection_blocked",
						message: "Deleted Session cleanup could not update the projection.",
					}
				: outcome.error;
		return catalogIssue(
			sessionId,
			Object.assign(new Error(failure.message), { code: failure.code })
		);
	};

	const reconcileDeletedSessionIds = async (
		sessionIds: ReadonlySet<SessionId>
	): Promise<SessionCatalogIssue[]> => {
		const issues: SessionCatalogIssue[] = [];
		for (const sessionId of [...sessionIds].sort()) {
			const issue = await reconcileDeletedSession(sessionId);
			if (issue !== undefined) {
				issues.push(issue);
			}
		}
		return issues;
	};

	const reconcileDeletedSessions = async (): Promise<SessionCatalogIssue[]> => {
		const deletedSessionIds = new Set(
			(await findDeletedMarkerSessionIds()).filter((sessionId) =>
				projection.isBoundToWorkspace(sessionId)
			)
		);
		for (const sessionId of await findPendingDeletionIntentSessionIds()) {
			deletedSessionIds.add(sessionId);
		}
		return reconcileDeletedSessionIds(deletedSessionIds);
	};

	const reconcileDeletedSessionsForRebuild = async (): Promise<
		SessionCatalogIssue[]
	> => {
		const deletedSessionIds = new Set(await findDeletedMarkerSessionIds());
		for (const sessionId of await findPendingDeletionIntentSessionIds()) {
			deletedSessionIds.add(sessionId);
		}
		return reconcileDeletedSessionIds(deletedSessionIds);
	};

	const reconcileDeletedSessionIfNeeded = async (
		sessionId: SessionId
	): Promise<void> => {
		if (!projection.isBoundToWorkspace(sessionId)) {
			return;
		}
		const marker = await sessionLog.readDeletedMarker(sessionId);
		const pendingIntent = await sessionLog.readWriteIntent(sessionId);
		if (marker === undefined && pendingIntent?.type !== "session.deleted") {
			return;
		}
		const issue = await reconcileDeletedSession(sessionId);
		if (issue !== undefined) {
			throw Object.assign(new Error(issue.message), {
				code: issue.code,
				sessionId,
			});
		}
	};

	const acquireRebuildWriters = async (
		sessionIds: readonly SessionId[]
	): Promise<{
		failure?: Readonly<{ error: unknown; sessionId: SessionId }>;
		writers: SessionWriterLock[];
	}> => {
		const writers: SessionWriterLock[] = [];
		let currentSessionId: SessionId | undefined;
		try {
			for (const sessionId of sessionIds) {
				currentSessionId = sessionId;
				const key = await lockKey(logRoot, sessionId);
				if (heldWriterKeys.has(key)) {
					continue;
				}
				writers.push(await acquireSessionWriterLock(logRoot, sessionId));
			}
		} catch (error) {
			for (const writer of writers.reverse()) {
				await writer.release();
			}
			if (currentSessionId === undefined) {
				throw error;
			}
			return { failure: { error, sessionId: currentSessionId }, writers: [] };
		}
		return { writers };
	};

	const releaseRebuildWriters = async (
		writers: readonly SessionWriterLock[]
	): Promise<void> => {
		for (const writer of [...writers].reverse()) {
			await writer.release();
		}
	};

	const projectRebuildSession = async (sessionId: SessionId): Promise<void> => {
		const root = await fs.realpath(logRoot);
		const logPath = resolveSessionLogFilePath(root, sessionId);
		const { bytes, state } = await sessionLog.readWithRetry(sessionId);
		if (
			state.entries.some(({ envelope }) => envelope.type === "session.deleted")
		) {
			throw new SessionLogError(
				"session_deleted",
				sessionId,
				"Session deletion must be reconciled before projection rebuild."
			);
		}
		await sessionLog.syncPrefix(logPath, bytes, sessionId);
		await sessionLog.reconcileVisibleWriteIntent(
			sessionId,
			logPath,
			bytes,
			state,
			projection.workspaceId
		);
		const cursor = projection.getCursor(sessionId);
		projection.projectEntries(
			sessionId,
			state.entries,
			state,
			cursor,
			"maintenance"
		);
		if (
			!sessionProjectionMatchesState(
				projection.getCursor(sessionId),
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
		await releaseReconciledAttachmentLeases(sessionId, state);
		const creationLease = pendingCreationAttachmentLeases.get(sessionId);
		if (
			creationLease !== undefined &&
			state.entries.some(
				({ envelope }) =>
					envelope.operationId === `create-${sessionId}` &&
					envelope.type === "session.created"
			)
		) {
			await releasePendingCreationAttachmentLease(sessionId, creationLease);
		}
	};

	const rebuildProjection: SessionLifecycle["rebuildProjection"] = (
		scope,
		gate
	) =>
		rebuildSessionJsonlProjection(
			{
				acquireWriters: acquireRebuildWriters,
				beginRebuild: projection.beginRebuild,
				completeRebuild: projection.completeRebuild,
				getGeneration: () => projection.getMaintenanceState().generation,
				getMaintenanceState: projection.getMaintenanceState,
				listProjectedSessionIds: async () => projection.listSessionIds(),
				projectSession: projectRebuildSession,
				readCatalogSnapshot,
				reconcileDeletedSessions: reconcileDeletedSessionsForRebuild,
				releaseWriters: releaseRebuildWriters,
				withAppendQueues,
				withCatalogLifecycleGate: (operation) =>
					withSessionCatalogLifecycleGate(logRoot, operation),
			},
			scope,
			gate
		);

	const receiptForSessionSubmission = async (
		sessionId: SessionId,
		submissionId: SubmissionId,
		state: SessionLogState
	): Promise<SessionSubmissionRecordReceipt | undefined> => {
		const match = findSessionSubmissionRecord(
			state.entries,
			sessionId,
			submissionId
		);
		if (match === undefined) {
			const unresolvedIntent = await sessionLog.readWriteIntent(sessionId);
			if (
				unresolvedIntent !== undefined &&
				!state.entries.some(
					({ envelope }) =>
						envelope.operationId === unresolvedIntent.operationId
				)
			) {
				throw new SessionLogError(
					"session_log_write_indeterminate",
					sessionId,
					"Session write must be reconciled before SDK delivery can proceed.",
					{
						offset: unresolvedIntent.expectedOffset,
						operationId: unresolvedIntent.operationId,
						sequence: unresolvedIntent.sequence,
					}
				);
			}
			return;
		}
		let projectionStatus: SessionWriteReceipt["projection"] = "blocked";
		try {
			if (
				sessionProjectionMatchesState(
					projection.getCursor(sessionId),
					state,
					projection.getMaintenanceState().generation
				)
			) {
				projectionStatus = "ready";
			}
		} catch {
			// The Session log remains authoritative when the SQLite cursor is unreadable.
		}
		try {
			await sessionLog.ensureReceipt(sessionId, match.entry);
		} catch (error) {
			if (
				error instanceof SessionLogError &&
				error.code === "session_operation_conflict"
			) {
				throw error;
			}
			projectionStatus = "blocked";
		}
		return {
			message: match.message,
			recordId: match.recordId,
			writeOutcome: toReceipt(match.entry, projectionStatus),
		};
	};

	const findSessionRecordBySubmissionId = async (
		sessionId: SessionId,
		submissionId: SubmissionId
	): Promise<SessionSubmissionRecordReceipt | undefined> => {
		await reconcileDeletedSessionIfNeeded(sessionId);
		return await withTemporaryWriter(sessionId, async () => {
			await projected.open(sessionId);
			await checkDeletedMarker(sessionId);
			const logPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				sessionId
			);
			const { bytes, state } = await sessionLog.readWithRetry(sessionId);
			await sessionLog.syncPrefix(logPath, bytes, sessionId);
			try {
				await sessionLog.reconcileVisibleWriteIntent(
					sessionId,
					logPath,
					bytes,
					state,
					projection.workspaceId
				);
			} catch (error) {
				if (
					!(
						error instanceof SessionWriteOutcomeError &&
						error.outcome.kind === "committed"
					)
				) {
					throw error;
				}
			}
			return receiptForSessionSubmission(sessionId, submissionId, state);
		});
	};

	projectionStore.setAttachmentCollectionBarrier(async () => {
		const catalog = await listSessionCatalog(false);
		if (catalog.issues.length > 0) {
			throw new Error(
				"Attachment collection is blocked while authoritative Session logs are unavailable."
			);
		}
	});

	return {
		acquireSessionWriter: acquireWriter,
		annotateMessagesForDisplay:
			projectionStore.attachmentStore.annotateMessagesForDisplay,
		appendCompaction,
		appendContextEdit,
		appendPluginSessionHistoryEntry,
		collectAttachments: projectionStore.collectAttachments,
		commitSessionRecord,
		completeSessionForkAction,
		confirmSessionImportActivation,
		createEmptySession,
		createSession,
		createSessionUsageEntry,
		createSessionWithExternalizedMessage,
		deleteSession,
		externalizeAttachments: projectionStore.externalizeAttachments,
		...(projectionStore.fileObservationStore === undefined
			? {}
			: { fileObservationStore: projectionStore.fileObservationStore }),
		findSessionRecordBySubmissionId,
		forkSession,
		forkSessionWithHeldWriter,
		getCompactionMetadata:
			projectionStore.attachmentStore.getCompactionMetadata,
		getCompactions: async (sessionId) =>
			await readThroughHandle(
				sessionId,
				(view) => view.getCompactions(),
				() => projectionStore.getCompactions(sessionId)
			),
		getEditMode: async (sessionId) =>
			await readThroughHandle(
				sessionId,
				(view) => view.getEditMode(),
				() => projectionStore.getEditMode(sessionId)
			),
		getLatestCompaction: async (sessionId) =>
			await readThroughHandle(
				sessionId,
				(view) => view.getLatestCompaction(),
				() => projectionStore.getLatestCompaction(sessionId)
			),
		getOrCreateSessionForkActionId,
		getPluginSessionState,
		getSession: async (sessionId) =>
			await readThroughHandle(
				sessionId,
				(view) => view.getSession(),
				() => projectionStore.getSession(sessionId)
			),
		getSessionForkProvenance,
		getSessionStatistics,
		hasSessionHistoryEntry,
		hydrateAttachments: projectionStore.hydrateAttachments,
		isSessionImportActivationPending,
		isSessionImported,
		listRecentModelSelections,
		listSessionCatalog,
		listSessionRecords: async (sessionId) =>
			await readThroughHandle(
				sessionId,
				(view) => view.listSessionRecords(),
				() => projectionStore.listSessionRecords(sessionId)
			),
		listSessions,
		listSessionsPage,
		listSessionUsageEntries: async (sessionId) =>
			await readThroughHandle(
				sessionId,
				(view) => view.listSessionUsageEntries(),
				() => projectionStore.listSessionUsageEntries(sessionId)
			),
		mutatePluginSessionState,
		navigateSessionHistory,
		readPluginSessionHistoryPage,
		readSessionHistoryPage,
		readSessionHistoryPath,
		readSessionHistoryTreePage,
		rebuildProjection,
		releaseAttachments: async (attachmentIds) => {
			await projectionStore.attachmentStore.release(attachmentIds);
		},
		resetSessionData,
		resolveAttachmentReference: async (reference, signal) =>
			await projectionStore.attachmentStore.resolve(reference, signal),
		retainAttachments: async (attachmentIds) => {
			await projectionStore.attachmentStore.retain(attachmentIds);
		},
		setEditMode,
		updateSession,
		updateSessionSubmission,
		withSessionBundleExport,
		withSessionBundleImport: importSessionBundle,
	};
};
