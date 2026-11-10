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
import { logger, omitUndefined, readUtf8File } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import { z } from "zod";
import {
	normalizeProviderModelSelection,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { EditMode } from "@/modules/tools";
import {
	type CompactionId,
	isValidSessionId,
	type SessionId,
	toCompactionId,
	toSessionId,
	toSessionUsageEntryId,
	toWorkspaceId,
	type WorkspaceId,
} from "@/shared/identifiers";
import { throwIfAborted } from "@/shared/utils/abort";
import { errorDiagnosticFields } from "@/shared/utils/error-log-fields";
import { createKeyedSerialQueue } from "@/shared/utils/keyed-serial-queue";
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
import type { SessionBundleImportResult } from "../session-bundle-contract";
import { assessSessionForkCheckpoint } from "../session-fork-checkpoint-validation";
import { isValidSessionLogIdentifier } from "../session-log-identifiers";
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
	buildSessionStatistics,
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
	type PreparedSessionBundleExport,
	type PreparedSessionBundleImport,
	prepareSessionBundleImport,
	SessionBundleImportConflictError,
	type SessionBundleImportFileSystem,
	SessionBundleImportIndeterminateError,
	SessionBundleValidationError,
	validateSessionBundleLog,
} from "./session-bundle";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	decodeSessionLog,
	decodeSessionLogSuffix,
	encodeCanonicalSessionJson,
	encodeSessionLogLine,
	parseSessionCompactionPayload,
	parseSessionForkedPayload,
	parseSessionSubmissionStatusPayload,
	SESSION_LOG_EVENT_TYPES,
	SESSION_LOG_HASH_PATTERN,
	type SessionCompactionPayload,
	type SessionForkedPayload,
	type SessionLogEntry,
	type SessionLogEnvelope,
	SessionLogError,
	type SessionLogEventType,
	type SessionLogState,
	type SessionProjectionCursor,
	sessionLogOperationDigest,
	sessionProjectionCursorsEqual,
} from "./session-jsonl-codec";
import { rebuildSessionJsonlProjection } from "./session-jsonl-rebuild";
import {
	decodeSessionHistoryReadPointToken,
	decodeSessionPageToken,
	encodeSessionPageToken,
	parseSessionPageLimit,
	type SessionCatalogPageCursor,
	type SessionHistoryPageCursor,
	SessionPaginationError,
} from "./session-pagination";
import { buildUserSessionRecord } from "./session-record";
import {
	ensureSessionDirectoryTreeDurably,
	publishSessionFileNoReplaceDurably,
	removeSessionFileDurably,
	replaceSessionFileDurably,
	syncDirectoryAfterDurablePathChange,
} from "./session-storage-durability";
import type {
	CommitSessionRecordInput,
	CreateEmptySessionInput,
	CreateSessionInput,
	CreateSessionUsageEntryInput,
	Session,
	SessionCatalogIssue,
	SessionCatalogPage,
	SessionCatalogResult,
	SessionDeletionOutcome,
	SessionForkCheckpoint,
	SessionForkProvenance,
	SessionForkResult,
	SessionForkSubmissionProvenance,
	SessionHistoryPage,
	SessionPageOptions,
	SessionStatistics,
	SessionStatisticsOptions,
	SessionStore,
	SessionSubmissionRecordReceipt,
	SessionUsageEntry,
	SessionWriteOutcome,
	SessionWriteReceipt,
	UpdateSessionInput,
	UpdateSessionSubmissionInput,
} from "./session-store";
import {
	acquireSessionWriterLock,
	SessionInUseError,
	type SessionWriterLock,
	SessionWriterLockFailureError,
	type SessionWriterLockOptions,
	withSessionCatalogLifecycleGate,
} from "./session-writer-lock";

export type SessionLogFileIo = Readonly<{
	sync?: (filePath: string, handle: fs.FileHandle) => Promise<void>;
	syncDirectory?: (directory: string, handle: fs.FileHandle) => Promise<void>;
	remove?: (
		filePath: string,
		options: Parameters<typeof fs.rm>[1]
	) => Promise<void>;
	write?: (
		filePath: string,
		handle: fs.FileHandle,
		bytes: Uint8Array,
		offset: number,
		length: number,
		position: number
	) => Promise<number>;
}>;

type SessionJsonlStoreTestObserver = Readonly<{
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

export class SessionForkError extends Error {
	readonly code:
		| "session_busy"
		| "session_checkpoint_invalid"
		| "session_operation_conflict";
	readonly operationId: string;
	readonly sourceSessionId: SessionId;

	constructor(
		code: SessionForkError["code"],
		message: string,
		sourceSessionId: SessionId,
		operationId: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = "SessionForkError";
		this.code = code;
		this.operationId = operationId;
		this.sourceSessionId = sourceSessionId;
	}
}

export class SessionWriteOutcomeError extends Error {
	readonly code: string;
	readonly outcome: SessionWriteOutcome;

	constructor(outcome: SessionWriteOutcome, cause?: unknown) {
		super(
			outcome.kind === "committed"
				? "Session log commit is durable, but its SQLite projection or receipt is unavailable."
				: outcome.error.message,
			cause === undefined ? undefined : { cause }
		);
		this.name = "SessionWriteOutcomeError";
		this.code =
			outcome.kind === "committed"
				? "session_projection_unavailable"
				: outcome.error.code;
		this.outcome = outcome;
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

type SessionWriteIntent = Readonly<{
	expectedOffset: number;
	operationDigest: string;
	operationId: string;
	sequence: number;
	sessionId: SessionId;
	timestamp?: string;
	type: SessionLogEventType;
	workspaceId?: WorkspaceId;
}>;

type SessionCreation = Readonly<{
	createdAt: Date;
	createdAtIsExplicit: boolean;
	editMode: EditMode;
	initialRecord?: SessionRecord;
	lastMessageAt: Date | null;
	model?: CreateEmptySessionInput["model"];
	pinned: boolean;
	thinkingLevel?: CreateEmptySessionInput["thinkingLevel"];
	title: string;
}>;

type SessionWrite = Readonly<{
	envelopeTimestamp?: string;
	operationId: string;
	payload: Readonly<Record<string, unknown>>;
	type: Exclude<SessionLogEnvelope["type"], "session.header">;
}>;

type CommittedLogEntry = Readonly<{
	createdNew: boolean;
	entry: SessionLogEntry;
	receiptBlocked: boolean;
	receiptCause?: unknown;
	state: SessionLogState;
}>;

const sessionDeletionOperationId = (sessionId: SessionId): string =>
	`delete-${validSessionId(sessionId)}`;
const operationIdFileStem = (operationId: string): string =>
	new Bun.CryptoHasher("sha256").update(operationId).digest("hex");

const appendQueue = createKeyedSerialQueue();
const forkOperationQueue = createKeyedSerialQueue();

const validSessionId = (sessionId: SessionId): string => {
	if (!isValidSessionId(sessionId)) {
		throw new Error("Session ID is not safe for a Session log path.");
	}
	return sessionId;
};

const canonicalLogRoot = async (logRoot: string): Promise<string> => {
	const resolvedRoot = path.resolve(logRoot);
	try {
		return await fs.realpath(resolvedRoot);
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
		return path.join(
			await fs.realpath(path.dirname(resolvedRoot)),
			path.basename(resolvedRoot)
		);
	}
};

const sessionControlRoot = async (logRoot: string): Promise<string> =>
	path.join(path.dirname(await canonicalLogRoot(logRoot)), "session-control");

const lockKey = async (
	logRoot: string,
	sessionId: SessionId
): Promise<string> => {
	await ensureDirectoryDurable(logRoot);
	return `${await canonicalLogRoot(logRoot)}\0${sessionId}`;
};

const isCode = (error: unknown, code: string): boolean =>
	typeof error === "object" &&
	error !== null &&
	Reflect.get(error, "code") === code;

const writeFully = async (
	handle: fs.FileHandle,
	bytes: Uint8Array,
	position: number,
	filePath: string,
	fileIo: SessionLogFileIo
): Promise<void> => {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const bytesWritten = fileIo.write
			? await fileIo.write(
					filePath,
					handle,
					bytes,
					offset,
					bytes.byteLength - offset,
					position + offset
				)
			: (
					await handle.write(
						bytes,
						offset,
						bytes.byteLength - offset,
						position + offset
					)
				).bytesWritten;
		if (bytesWritten <= 0) {
			throw new Error("Session log write made no progress.");
		}
		offset += bytesWritten;
	}
};

const syncFile = async (
	filePath: string,
	handle: fs.FileHandle,
	fileIo: SessionLogFileIo
): Promise<void> => {
	if (fileIo.sync !== undefined) {
		await fileIo.sync(filePath, handle);
		return;
	}
	await handle.sync();
};

/** Windows FlushFileBuffers requires GENERIC_WRITE, including for existing files. */
const openFileForSync = (filePath: string): Promise<fs.FileHandle> =>
	fs.open(filePath, process.platform === "win32" ? "r+" : "r");

const syncDirectory = async (
	directory: string,
	fileIo?: SessionLogFileIo
): Promise<void> => {
	if (process.platform === "win32" && fileIo?.syncDirectory === undefined) {
		throw new Error(
			"Windows Session durability requires write-through path publication, not directory-handle sync."
		);
	}
	const handle = await fs.open(directory, "r");
	try {
		if (fileIo?.syncDirectory !== undefined) {
			await fileIo.syncDirectory(directory, handle);
			return;
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
};

const syncDirectoryAfterDurablePublication = async (
	directory: string,
	fileIo?: SessionLogFileIo
): Promise<void> =>
	await syncDirectoryAfterDurablePathChange(
		directory,
		async (path) => await syncDirectory(path, fileIo),
		fileIo?.syncDirectory !== undefined
	);

const ensureDirectoryDurable = async (
	directory: string,
	mode = 0o700,
	fileIo?: SessionLogFileIo
): Promise<void> =>
	await ensureSessionDirectoryTreeDurably(
		directory,
		mode,
		async (parent) => await syncDirectory(parent, fileIo),
		fileIo?.syncDirectory !== undefined,
		"Session log path is not a directory."
	);

const readLog = async (
	logPath: string,
	sessionId: SessionId
): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
	const bytes = await Bun.file(logPath).bytes();
	return { bytes, state: decodeSessionLog(sessionId, bytes) };
};

const firstDifferentByteOffset = (
	left: Uint8Array,
	right: Uint8Array
): number | undefined => {
	const commonLength = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < commonLength; index += 1) {
		if (left[index] !== right[index]) {
			return index;
		}
	}
	return left.byteLength === right.byteLength ? undefined : commonLength;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
	firstDifferentByteOffset(left, right) === undefined;

const sessionWriteIntentPath = async (
	logRoot: string,
	sessionId: SessionId
): Promise<string> =>
	path.join(
		await sessionControlRoot(logRoot),
		"indeterminate",
		`${validSessionId(sessionId)}.json`
	);

export type SessionLogVerification = Readonly<{
	byteLength: number;
	eventCount: number;
	lastHash: string;
	lastSequence: number;
	logId: string;
	reconciliationPending: boolean;
	sessionId: SessionId;
}>;

/**
 * Validates a Session log with the same decoder used by writable reopen. This
 * inspection reads the log and pending marker only; it does not acquire writer
 * authority, sync files, or repair an incomplete suffix.
 */
export const verifySessionJsonlLog = async (
	logRoot: string,
	sessionId: SessionId
): Promise<SessionLogVerification> => {
	const logPath = resolveSessionLogFilePath(path.resolve(logRoot), sessionId);
	const { bytes, state } = await readLog(logPath, sessionId);
	let reconciliationPending = false;
	try {
		await fs.access(await sessionWriteIntentPath(logRoot, sessionId));
		reconciliationPending = true;
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
	}
	return {
		byteLength: bytes.byteLength,
		eventCount: Math.max(0, state.entries.length - 1),
		lastHash: state.lastHash,
		lastSequence: state.nextSequence - 1,
		logId: state.logId,
		reconciliationPending,
		sessionId,
	};
};

const isWritableSessionLogEventType = (
	type: unknown
): type is SessionLogEventType =>
	typeof type === "string" &&
	SESSION_LOG_EVENT_TYPES.includes(type as SessionLogEventType) &&
	type !== "session.header";

const isCanonicalTimestamp = (value: unknown): value is string => {
	if (typeof value !== "string") {
		return false;
	}
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

const sessionWriteIntentMetadataFrom = (
	value: object,
	type: unknown,
	sessionId: SessionId
): Pick<SessionWriteIntent, "timestamp" | "workspaceId"> => {
	const timestamp = Reflect.get(value, "timestamp");
	const storedWorkspaceId = Reflect.get(value, "workspaceId");
	const version = Reflect.get(value, "version");
	const parsedTimestamp = isCanonicalTimestamp(timestamp)
		? timestamp
		: undefined;
	const parsedWorkspaceId =
		typeof storedWorkspaceId === "string" &&
		storedWorkspaceId.length > 0 &&
		storedWorkspaceId.length <= 256
			? toWorkspaceId(storedWorkspaceId)
			: undefined;
	const validVersion = version === 1 || version === 2 || version === 3;
	const validTimestamp =
		version === 1
			? timestamp === undefined || parsedTimestamp !== undefined
			: (version === 2 || version === 3) && parsedTimestamp !== undefined;
	const validWorkspaceId =
		version === 3
			? type === "session.created" && parsedWorkspaceId !== undefined
			: storedWorkspaceId === undefined;
	if (!(validVersion && validTimestamp && validWorkspaceId)) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session has an invalid pending write marker."
		);
	}
	return omitUndefined({
		timestamp: parsedTimestamp,
		workspaceId: parsedWorkspaceId,
	});
};

const sessionWriteIntentFrom = (
	value: unknown,
	sessionId: SessionId
): SessionWriteIntent => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session has an invalid pending write marker."
		);
	}
	const type = Reflect.get(value, "type");
	const operationId = Reflect.get(value, "operationId");
	const storedSessionId = Reflect.get(value, "sessionId");
	const operationDigest = Reflect.get(value, "operationDigest");
	const expectedOffset = Reflect.get(value, "expectedOffset");
	const sequence = Reflect.get(value, "sequence");
	const metadata = sessionWriteIntentMetadataFrom(value, type, sessionId);
	const validSequence =
		type === "session.created" ? sequence === 1 : Number(sequence) >= 2;
	const validOffset =
		type === "session.created"
			? expectedOffset === 0
			: Number(expectedOffset) > 0;
	if (
		!(isWritableSessionLogEventType(type) && validSequence && validOffset) ||
		typeof operationId !== "string" ||
		!isValidSessionLogIdentifier(operationId) ||
		storedSessionId !== sessionId ||
		typeof operationDigest !== "string" ||
		!SESSION_LOG_HASH_PATTERN.test(operationDigest) ||
		!Number.isSafeInteger(expectedOffset) ||
		!Number.isSafeInteger(sequence)
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session has an invalid pending write marker."
		);
	}
	return {
		expectedOffset,
		operationDigest,
		operationId,
		sequence,
		sessionId,
		...metadata,
		type,
	};
};

const assertSameSessionWriteIntent = (
	intent: SessionWriteIntent,
	expected: Pick<
		SessionWriteIntent,
		"operationDigest" | "operationId" | "type" | "workspaceId"
	>,
	sessionId: SessionId,
	allowLegacyWorkspaceOwner = false
): void => {
	if (intent.operationId !== expected.operationId) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			`Session write ${intent.operationId} must be reconciled before another write.`,
			{
				offset: intent.expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	}
	if (
		intent.type !== expected.type ||
		intent.operationDigest !== expected.operationDigest ||
		(intent.workspaceId !== expected.workspaceId && !allowLegacyWorkspaceOwner)
	) {
		throw new SessionLogError(
			"session_operation_conflict",
			sessionId,
			"A Session operation identity was retried with a different payload.",
			{
				offset: intent.expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	}
};

const readSessionWriteIntent = async (
	logRoot: string,
	sessionId: SessionId,
	fileIo: SessionLogFileIo
): Promise<SessionWriteIntent | undefined> => {
	const markerPath = await sessionWriteIntentPath(logRoot, sessionId);
	let markerText: string;
	try {
		markerText = await fs.readFile(markerPath, "utf8");
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session pending write marker could not be read.",
			{ cause: error }
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(markerText);
	} catch {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session has an invalid pending write marker."
		);
	}
	const intent = sessionWriteIntentFrom(value, sessionId);
	let handle: fs.FileHandle;
	try {
		handle = await openFileForSync(markerPath);
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session pending write marker could not be opened.",
			{
				cause: error,
				offset: intent.expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	}
	try {
		await syncFile(markerPath, handle, fileIo);
	} catch (error) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session pending write marker durability could not be confirmed.",
			{
				cause: error,
				offset: intent.expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	} finally {
		await handle.close();
	}
	try {
		await syncDirectoryAfterDurablePublication(
			path.dirname(markerPath),
			fileIo
		);
	} catch (error) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session pending write marker directory durability could not be confirmed.",
			{
				cause: error,
				offset: intent.expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	}
	return intent;
};

const writeSessionWriteIntent = async (
	logRoot: string,
	intent: SessionWriteIntent & Readonly<{ timestamp: string }>,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const controlRoot = await sessionControlRoot(logRoot);
	const markerRoot = path.join(controlRoot, "indeterminate");
	const markerPath = await sessionWriteIntentPath(logRoot, intent.sessionId);
	await ensureDirectoryDurable(controlRoot);
	await ensureDirectoryDurable(markerRoot);
	const existing = await readSessionWriteIntent(
		logRoot,
		intent.sessionId,
		fileIo
	);
	const upgradeLegacyIntent =
		existing !== undefined && existing.timestamp === undefined;
	if (existing !== undefined) {
		assertSameSessionWriteIntent(existing, intent, intent.sessionId);
		if (!upgradeLegacyIntent) {
			return;
		}
	}
	const temporaryPath = `${markerPath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		const bytes = new TextEncoder().encode(
			`${encodeCanonicalSessionJson({
				...intent,
				version: intent.workspaceId === undefined ? 2 : 3,
			})}\n`
		);
		await writeFully(handle, bytes, 0, temporaryPath, fileIo);
		await syncFile(temporaryPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		if (upgradeLegacyIntent) {
			await replaceSessionFileDurably(
				temporaryPath,
				markerPath,
				async (directory) => await syncDirectory(directory, fileIo),
				fileIo.syncDirectory !== undefined
			);
			return;
		}
		try {
			await publishSessionFileNoReplaceDurably(
				temporaryPath,
				markerPath,
				async (directory) => await syncDirectory(directory, fileIo),
				fileIo.syncDirectory !== undefined
			);
		} catch (error) {
			if (!isCode(error, "EEXIST")) {
				throw error;
			}
			const raced = await readSessionWriteIntent(
				logRoot,
				intent.sessionId,
				fileIo
			);
			if (raced === undefined) {
				throw new Error("Pending Session write marker disappeared.");
			}
			assertSameSessionWriteIntent(raced, intent, intent.sessionId);
			return;
		}
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (error instanceof SessionLogError) {
			throw error;
		}
		logger.warn("Session pending write marker could not be persisted", {
			...errorDiagnosticFields(error),
			operationId: intent.operationId,
			platform: process.platform,
			sessionId: intent.sessionId,
		});
		throw new SessionLogError(
			upgradeLegacyIntent
				? "session_log_write_indeterminate"
				: "session_log_write_not_committed",
			intent.sessionId,
			upgradeLegacyIntent
				? "Session write could not durably upgrade its pending marker."
				: "Session write could not persist its pending marker before log mutation.",
			{
				cause: error,
				offset: intent.expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

const sessionForkIntentSchema = z
	.object({
		checkpointRecordId: z.string().min(1).max(512),
		operationDigest: z.string().regex(/^[0-9a-f]{64}$/u),
		operationId: z.string().min(1).max(512),
		sourceSessionId: z.string().min(1).max(512),
		targetSessionId: z.string().min(1).max(512),
		version: z.literal(1),
	})
	.strict();

type SessionForkIntent = z.infer<typeof sessionForkIntentSchema>;

const sessionForkIntentPath = async (
	logRoot: string,
	operationId: string
): Promise<string> =>
	path.join(
		await sessionControlRoot(logRoot),
		"forks",
		`${operationIdFileStem(operationId)}.json`
	);

const readSessionForkIntent = async (
	logRoot: string,
	operationId: string,
	sourceSessionId: SessionId
): Promise<SessionForkIntent | undefined> => {
	const intentPath = await sessionForkIntentPath(logRoot, operationId);
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(intentPath).text());
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sourceSessionId,
			"Session fork operation intent could not be read.",
			{ cause: error, operationId }
		);
	}
	const parsed = sessionForkIntentSchema.safeParse(value);
	if (!parsed.success || parsed.data.operationId !== operationId) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sourceSessionId,
			"Session fork operation intent is invalid.",
			{ operationId }
		);
	}
	return parsed.data;
};

const publishCreateOnceJsonMarker = async <Value>({
	directory,
	fileIo,
	markerPath,
	missingRaceMessage,
	readExisting,
	value,
}: Readonly<{
	directory: string;
	fileIo: SessionLogFileIo;
	markerPath: string;
	missingRaceMessage: string;
	readExisting: () => Promise<Value | undefined>;
	value: Value;
}>): Promise<Value> => {
	const temporaryPath = `${markerPath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		const bytes = new TextEncoder().encode(
			`${encodeCanonicalSessionJson(value)}\n`
		);
		await writeFully(handle, bytes, 0, temporaryPath, fileIo);
		await syncFile(temporaryPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		try {
			await publishSessionFileNoReplaceDurably(
				temporaryPath,
				markerPath,
				async (directory) => await syncDirectory(directory, fileIo),
				fileIo.syncDirectory !== undefined
			);
		} catch (error) {
			if (!isCode(error, "EEXIST")) {
				throw error;
			}
			const raced = await readExisting();
			if (raced === undefined) {
				throw new Error(missingRaceMessage);
			}
			return raced;
		}
		await syncDirectoryAfterDurablePublication(directory, fileIo);
		return value;
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

const writeSessionForkIntent = async (
	logRoot: string,
	intent: SessionForkIntent,
	sourceSessionId: SessionId,
	fileIo: SessionLogFileIo
): Promise<SessionForkIntent> => {
	const markerPath = await sessionForkIntentPath(logRoot, intent.operationId);
	const markerRoot = path.dirname(markerPath);
	await ensureDirectoryDurable(markerRoot, 0o700, fileIo);
	try {
		return await publishCreateOnceJsonMarker({
			directory: markerRoot,
			fileIo,
			markerPath,
			missingRaceMessage: "Session fork operation intent disappeared.",
			readExisting: async () =>
				await readSessionForkIntent(
					logRoot,
					intent.operationId,
					sourceSessionId
				),
			value: intent,
		});
	} catch (error) {
		if (error instanceof SessionLogError) {
			throw error;
		}
		throw new SessionLogError(
			"session_log_write_not_committed",
			sourceSessionId,
			"Session fork operation intent could not be made durable.",
			{ cause: error, operationId: intent.operationId }
		);
	}
};

const clearSessionForkIntent = async (
	logRoot: string,
	intent: SessionForkIntent,
	sourceSessionId: SessionId,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const markerPath = await sessionForkIntentPath(logRoot, intent.operationId);
	const existing = await readSessionForkIntent(
		logRoot,
		intent.operationId,
		sourceSessionId
	);
	if (existing === undefined || !Bun.deepEquals(existing, intent, true)) {
		return;
	}
	await removeSessionFileDurably(
		markerPath,
		await sessionControlRoot(logRoot),
		async (directory) => await syncDirectory(directory, fileIo)
	);
};

/** Pending UI retry identity is control metadata, not a source-log mutation. */
const sessionForkActionSchema = z
	.object({
		checkpointRecordId: z.string().min(1).max(512),
		operationId: z.string().min(1).max(512),
		sourceSessionId: z.string().min(1).max(512),
		version: z.literal(1),
	})
	.strict();

type SessionForkAction = z.infer<typeof sessionForkActionSchema>;

const sessionForkActionPath = async (
	logRoot: string,
	sourceSessionId: SessionId,
	checkpoint: SessionForkCheckpoint
): Promise<string> => {
	const identity = new Bun.CryptoHasher("sha256")
		.update(`${sourceSessionId}\0${checkpoint.recordId}`)
		.digest("hex");
	return path.join(
		await sessionControlRoot(logRoot),
		"fork-actions",
		`${identity}.json`
	);
};

const readSessionForkAction = async (
	logRoot: string,
	sourceSessionId: SessionId,
	checkpoint: SessionForkCheckpoint
): Promise<SessionForkAction | undefined> => {
	const actionPath = await sessionForkActionPath(
		logRoot,
		sourceSessionId,
		checkpoint
	);
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(actionPath).text());
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sourceSessionId,
			"Pending Session fork action could not be read.",
			{ cause: error }
		);
	}
	const parsed = sessionForkActionSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.sourceSessionId !== sourceSessionId ||
		parsed.data.checkpointRecordId !== checkpoint.recordId
	) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sourceSessionId,
			"Pending Session fork action is invalid."
		);
	}
	return parsed.data;
};

const writeSessionForkAction = async (
	logRoot: string,
	action: SessionForkAction,
	checkpoint: SessionForkCheckpoint,
	fileIo: SessionLogFileIo
): Promise<SessionForkAction> => {
	const sourceSessionId = toSessionId(action.sourceSessionId);
	const actionPath = await sessionForkActionPath(
		logRoot,
		sourceSessionId,
		checkpoint
	);
	const actionRoot = path.dirname(actionPath);
	await ensureDirectoryDurable(actionRoot, 0o700, fileIo);
	try {
		return await publishCreateOnceJsonMarker({
			directory: actionRoot,
			fileIo,
			markerPath: actionPath,
			missingRaceMessage: "Pending Session fork action disappeared.",
			readExisting: async () =>
				await readSessionForkAction(logRoot, sourceSessionId, checkpoint),
			value: action,
		});
	} catch (error) {
		if (error instanceof SessionLogError) {
			throw error;
		}
		throw new SessionLogError(
			"session_log_write_not_committed",
			sourceSessionId,
			"Session fork action could not be made durable.",
			{ cause: error, operationId: action.operationId }
		);
	}
};

const clearSessionForkAction = async (
	logRoot: string,
	sourceSessionId: SessionId,
	checkpoint: SessionForkCheckpoint,
	operationId: string,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const existing = await readSessionForkAction(
		logRoot,
		sourceSessionId,
		checkpoint
	);
	if (existing === undefined) {
		return;
	}
	if (existing.operationId !== operationId) {
		throw new SessionForkError(
			"session_operation_conflict",
			"Session fork action completion does not match its pending operation.",
			sourceSessionId,
			operationId
		);
	}
	const actionPath = await sessionForkActionPath(
		logRoot,
		sourceSessionId,
		checkpoint
	);
	try {
		await removeSessionFileDurably(
			actionPath,
			await sessionControlRoot(logRoot),
			async (directory) => await syncDirectory(directory, fileIo)
		);
	} catch (error) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sourceSessionId,
			"Completed Session fork action could not be cleared.",
			{ cause: error, operationId }
		);
	}
};

const clearSessionWriteIntent = async (
	logRoot: string,
	intent: SessionWriteIntent,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const markerPath = await sessionWriteIntentPath(logRoot, intent.sessionId);
	const existing = await readSessionWriteIntent(
		logRoot,
		intent.sessionId,
		fileIo
	);
	if (existing === undefined) {
		return;
	}
	assertSameSessionWriteIntent(existing, intent, intent.sessionId);
	await removeSessionFileDurably(
		markerPath,
		await sessionControlRoot(logRoot),
		async (directory) => await syncDirectory(directory, fileIo)
	);
};

const syncAndVerifyLogSuffix = async (
	logPath: string,
	startOffset: number,
	capturedBytes: Uint8Array,
	sessionId: SessionId,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const handle = await openFileForSync(logPath);
	try {
		await syncFile(logPath, handle, fileIo);
	} finally {
		await handle.close();
	}
	const endOffset = startOffset + capturedBytes.byteLength;
	const { size } = await fs.stat(logPath);
	const current =
		size < endOffset
			? new Uint8Array()
			: await Bun.file(logPath).slice(startOffset, endOffset).bytes();
	if (!equalBytes(capturedBytes, current)) {
		const offset = firstDifferentByteOffset(capturedBytes, current);
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log suffix changed while its projection was being checked.",
			{ offset: startOffset + (offset ?? capturedBytes.byteLength) }
		);
	}
};

const syncAndVerifyLogPrefix = async (
	logPath: string,
	capturedBytes: Uint8Array,
	sessionId: SessionId,
	fileIo: SessionLogFileIo,
	sequence?: number
): Promise<void> => {
	const handle = await openFileForSync(logPath);
	try {
		await syncFile(logPath, handle, fileIo);
	} finally {
		await handle.close();
	}
	const current = await Bun.file(logPath).bytes();
	if (
		current.byteLength < capturedBytes.byteLength ||
		!equalBytes(current.subarray(0, capturedBytes.byteLength), capturedBytes)
	) {
		const offset = firstDifferentByteOffset(capturedBytes, current);
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log changed while its projection was being checked.",
			{
				offset: offset ?? capturedBytes.byteLength,
				...omitUndefined({ sequence }),
			}
		);
	}
};

const ensureDurableQuarantineArtifact = async (
	filePath: string,
	expectedBytes: Uint8Array,
	sessionId: SessionId,
	intent: SessionWriteIntent,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const temporaryPath = `${filePath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		try {
			handle = await openFileForSync(filePath);
			const existing = await Bun.file(filePath).bytes();
			if (!equalBytes(existing, expectedBytes)) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"Quarantine artifact conflicts with the pending Session write.",
					{
						offset: intent.expectedOffset,
						operationId: intent.operationId,
						sequence: intent.sequence,
					}
				);
			}
			await syncFile(filePath, handle, fileIo);
		} catch (error) {
			if (!isCode(error, "ENOENT")) {
				throw error;
			}
			await handle?.close().catch(() => undefined);
			handle = await fs.open(temporaryPath, "wx", 0o600);
			await writeFully(handle, expectedBytes, 0, temporaryPath, fileIo);
			await syncFile(temporaryPath, handle, fileIo);
			await handle.close();
			handle = undefined;
			try {
				await publishSessionFileNoReplaceDurably(
					temporaryPath,
					filePath,
					async (directory) => await syncDirectory(directory, fileIo),
					fileIo.syncDirectory !== undefined
				);
			} catch (linkError) {
				if (!isCode(linkError, "EEXIST")) {
					throw linkError;
				}
				const existing = await Bun.file(filePath).bytes();
				if (!equalBytes(existing, expectedBytes)) {
					throw new SessionLogError(
						"session_log_corrupt",
						sessionId,
						"Quarantine artifact conflicts with the pending Session write.",
						{
							offset: intent.expectedOffset,
							operationId: intent.operationId,
							sequence: intent.sequence,
						}
					);
				}
			}
		}
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

const quarantinePartialLogAppend = async (
	logRoot: string,
	logPath: string,
	sessionId: SessionId,
	intent: SessionWriteIntent,
	bytes: Uint8Array,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const expectedOffset = intent.expectedOffset;
	if (
		expectedOffset <= 0 ||
		expectedOffset >= bytes.byteLength ||
		bytes[expectedOffset - 1] !== 0x0a ||
		bytes[bytes.byteLength - 1] === 0x0a
	) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session log has an incomplete suffix outside the pending write boundary.",
			{
				offset: expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	}
	const prefix = bytes.subarray(0, expectedOffset);
	const prefixState = decodeSessionLog(sessionId, prefix);
	if (
		prefixState.nextSequence !== intent.sequence ||
		prefixState.nextOffset !== expectedOffset
	) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session log prefix does not match its pending write marker.",
			{
				offset: expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	}
	const controlRoot = await sessionControlRoot(logRoot);
	const quarantineRoot = path.join(
		controlRoot,
		"quarantine",
		validSessionId(sessionId)
	);
	await ensureDirectoryDurable(controlRoot, 0o700, fileIo);
	await ensureDirectoryDurable(path.dirname(quarantineRoot), 0o700, fileIo);
	await ensureDirectoryDurable(quarantineRoot, 0o700, fileIo);
	const quarantinePath = path.join(
		quarantineRoot,
		`${intent.sequence}-${operationIdFileStem(intent.operationId)}.partial`
	);
	const quarantineBytes = bytes.subarray(expectedOffset);
	await ensureDurableQuarantineArtifact(
		quarantinePath,
		quarantineBytes,
		sessionId,
		intent,
		fileIo
	);
	const quarantineMetadata = {
		byteLength: quarantineBytes.byteLength,
		offset: expectedOffset,
		operationId: intent.operationId,
		prefixHash: prefixState.lastHash,
		reason: "incomplete-final-line",
		sequence: intent.sequence,
		sessionId,
		suffixHash: new Bun.CryptoHasher("sha256")
			.update(quarantineBytes)
			.digest("hex"),
		version: 1,
	};
	await ensureDurableQuarantineArtifact(
		`${quarantinePath}.json`,
		new TextEncoder().encode(
			`${encodeCanonicalSessionJson(quarantineMetadata)}\n`
		),
		sessionId,
		intent,
		fileIo
	);
	const current = await Bun.file(logPath).bytes();
	if (!equalBytes(current, bytes)) {
		throw new SessionLogError(
			"session_log_write_indeterminate",
			sessionId,
			"Session log changed while its incomplete suffix was being quarantined.",
			{
				offset: expectedOffset,
				operationId: intent.operationId,
				sequence: intent.sequence,
			}
		);
	}
	const logHandle = await fs.open(logPath, "r+");
	try {
		if ((await logHandle.stat()).size !== bytes.byteLength) {
			throw new Error("Session log changed before suffix truncation.");
		}
		await logHandle.truncate(expectedOffset);
		await syncFile(logPath, logHandle, fileIo);
	} finally {
		await logHandle.close();
	}
	await syncDirectoryAfterDurablePublication(path.dirname(logPath), fileIo);
	await syncAndVerifyLogPrefix(logPath, prefix, sessionId, fileIo);
};

const findOperation = (
	state: SessionLogState,
	write: SessionWrite,
	sessionId: SessionId
): SessionLogEntry | undefined => {
	const previous = state.entries.find(
		({ envelope }) => envelope.operationId === write.operationId
	);
	if (previous === undefined) {
		return;
	}
	const { envelope } = previous;
	const previousDigest = sessionLogOperationDigest(
		envelope.type,
		envelope.payload
	);
	const requestedDigest = sessionLogOperationDigest(write.type, write.payload);
	if (previousDigest !== requestedDigest) {
		throw new SessionLogError(
			"session_operation_conflict",
			sessionId,
			"A Session operation identity was reused with a different payload.",
			{ sequence: envelope.sequence, offset: previous.startOffset }
		);
	}
	return previous;
};

const creationDigest = (payload: Readonly<Record<string, unknown>>): string => {
	const {
		createdAt: _createdAt,
		lastMessageAt: _lastMessageAt,
		...semantic
	} = payload;
	return sessionLogOperationDigest("session.created", semantic);
};

const findCreationOperation = (
	state: SessionLogState,
	write: SessionWrite,
	sessionId: SessionId
): SessionLogEntry | undefined => {
	const previous = state.entries.find(
		({ envelope }) => envelope.operationId === write.operationId
	);
	if (previous === undefined) {
		return;
	}
	if (
		previous.envelope.type !== "session.created" ||
		creationDigest(previous.envelope.payload) !==
			creationDigest(write.payload) ||
		previous.envelope.payload.createdAt !== write.payload.createdAt ||
		previous.envelope.payload.lastMessageAt !== write.payload.lastMessageAt
	) {
		throw new SessionLogError(
			"session_operation_conflict",
			sessionId,
			"A Session creation identity was reused with a different payload.",
			{ offset: previous.startOffset, sequence: previous.envelope.sequence }
		);
	}
	return previous;
};

type DurableSessionReceipt = Readonly<{
	entryHash: string;
	logId?: string;
	operationId: string;
	sequence: number;
	sessionId: string;
}>;

const isDurableSessionReceipt = (
	value: unknown
): value is DurableSessionReceipt => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const receipt = value as Record<string, unknown>;
	return (
		typeof receipt.entryHash === "string" &&
		(receipt.logId === undefined || typeof receipt.logId === "string") &&
		typeof receipt.operationId === "string" &&
		Number.isSafeInteger(receipt.sequence) &&
		typeof receipt.sessionId === "string"
	);
};

const publishReceiptReplacement = async (
	receiptPath: string,
	bytes: Uint8Array,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const temporaryPath = `${receiptPath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await writeFully(handle, bytes, 0, temporaryPath, fileIo);
		await syncFile(temporaryPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		await replaceSessionFileDurably(
			temporaryPath,
			receiptPath,
			async (directory) => await syncDirectory(directory, fileIo),
			fileIo.syncDirectory !== undefined
		);
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

const verifyOrRepairExistingReceipt = async (
	receiptPath: string,
	receiptRoot: string,
	expected: DurableSessionReceipt,
	expectedText: string,
	bytes: Uint8Array,
	sessionId: SessionId,
	fileIo: SessionLogFileIo
): Promise<void> => {
	let existing: string;
	try {
		existing = await fs.readFile(receiptPath, "utf8");
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
		await publishReceiptReplacement(receiptPath, bytes, fileIo);
		return;
	}
	let value: unknown;
	try {
		value = JSON.parse(existing);
	} catch {
		await publishReceiptReplacement(receiptPath, bytes, fileIo);
		return;
	}
	if (!isDurableSessionReceipt(value)) {
		await publishReceiptReplacement(receiptPath, bytes, fileIo);
		return;
	}
	if (encodeCanonicalSessionJson(value) !== expectedText) {
		throw new SessionLogError(
			"session_operation_conflict",
			sessionId,
			"A durable Session receipt conflicts with its committed log entry.",
			{ sequence: expected.sequence }
		);
	}
	let handle: fs.FileHandle;
	try {
		handle = await openFileForSync(receiptPath);
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
		await publishReceiptReplacement(receiptPath, bytes, fileIo);
		return;
	}
	try {
		await syncFile(receiptPath, handle, fileIo);
	} finally {
		await handle.close();
	}
	await syncDirectoryAfterDurablePublication(receiptRoot, fileIo);
};

const ensureDurableReceipt = async (
	logRoot: string,
	sessionId: SessionId,
	entry: SessionLogEntry,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const controlRoot = await sessionControlRoot(logRoot);
	const receiptRoot = path.join(
		controlRoot,
		"receipts",
		validSessionId(sessionId)
	);
	await ensureDirectoryDurable(controlRoot);
	await ensureDirectoryDurable(path.join(controlRoot, "receipts"));
	await ensureDirectoryDurable(receiptRoot);
	const receiptPath = path.join(
		receiptRoot,
		`${operationIdFileStem(entry.envelope.operationId)}.json`
	);
	const receipt: DurableSessionReceipt = {
		entryHash: entry.envelope.entryHash,
		logId:
			entry.envelope.sequence === 0 &&
			typeof entry.envelope.payload.logId === "string"
				? entry.envelope.payload.logId
				: undefined,
		operationId: entry.envelope.operationId,
		sequence: entry.envelope.sequence,
		sessionId,
	};
	const expectedText = encodeCanonicalSessionJson(receipt);
	const bytes = new TextEncoder().encode(`${expectedText}\n`);
	const temporaryPath = `${receiptPath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await writeFully(handle, bytes, 0, temporaryPath, fileIo);
		await syncFile(temporaryPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		await publishSessionFileNoReplaceDurably(
			temporaryPath,
			receiptPath,
			async (directory) => await syncDirectory(directory, fileIo),
			fileIo.syncDirectory !== undefined
		);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (!isCode(error, "EEXIST")) {
			throw error;
		}
		await verifyOrRepairExistingReceipt(
			receiptPath,
			receiptRoot,
			receipt,
			expectedText,
			bytes,
			sessionId,
			fileIo
		);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

type StagedSessionLog = Readonly<{
	filePath: string;
	root: string;
}>;

const stageSessionLog = async (
	canonicalRoot: string,
	sessionId: SessionId,
	operationId: string,
	bytes: Uint8Array,
	fileIo: SessionLogFileIo
): Promise<StagedSessionLog> => {
	const root = path.join(canonicalRoot, ".staging");
	const filePath = path.join(root, `${operationIdFileStem(operationId)}.jsonl`);
	let handle: fs.FileHandle | undefined;
	try {
		await ensureDirectoryDurable(root);
		// A prior process may have crashed after staging but before publishing.
		await fs.rm(filePath, { force: true });
		handle = await fs.open(filePath, "wx", 0o600);
		await writeFully(handle, bytes, 0, filePath, fileIo);
		await syncFile(filePath, handle, fileIo);
		await handle.close();
		handle = undefined;
		return { filePath, root };
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(filePath, { force: true }).catch(() => undefined);
		throw new SessionLogError(
			"session_log_write_not_committed",
			sessionId,
			"Session creation was not published to the authoritative log.",
			{ cause: error, operationId }
		);
	}
};

const sessionCreationTimestamps = (
	creation: SessionCreation,
	pendingIntent: SessionWriteIntent | undefined,
	existingCreation: Readonly<Record<string, unknown>> | undefined,
	operationId: string
): Readonly<{ createdAt: string; lastMessageAt: string | null }> => {
	const storedCreatedAt = isCanonicalTimestamp(existingCreation?.createdAt)
		? new Date(existingCreation.createdAt)
		: undefined;
	const pendingCreatedAt =
		pendingIntent?.operationId === operationId &&
		pendingIntent.type === "session.created" &&
		pendingIntent.timestamp !== undefined
			? new Date(pendingIntent.timestamp)
			: undefined;
	const createdAt = creation.createdAtIsExplicit
		? creation.createdAt
		: (storedCreatedAt ?? pendingCreatedAt ?? creation.createdAt);
	const lastMessageAt =
		creation.lastMessageAt?.getTime() === creation.createdAt.getTime()
			? createdAt
			: creation.lastMessageAt;
	return {
		createdAt: createdAt.toISOString(),
		lastMessageAt: lastMessageAt?.toISOString() ?? null,
	};
};

const readExistingSessionLog = async (
	logPath: string,
	sessionId: SessionId
): Promise<
	Readonly<{ bytes: Uint8Array; state: SessionLogState }> | undefined
> => {
	try {
		return await readLog(logPath, sessionId);
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw error;
	}
};

const assertCreationIntentTimestampMatches = (
	creation: SessionCreation,
	intent: SessionWriteIntent | undefined,
	existingCreation: Readonly<Record<string, unknown>> | undefined,
	operationId: string,
	sessionId: SessionId
): void => {
	if (
		intent?.operationId !== operationId ||
		intent.type !== "session.created"
	) {
		return;
	}
	const persistedTimestamp =
		intent.timestamp ??
		(isCanonicalTimestamp(existingCreation?.createdAt)
			? existingCreation.createdAt
			: undefined);
	if (persistedTimestamp === undefined) {
		const explicitTimestamp = creation.createdAtIsExplicit;
		throw new SessionLogError(
			explicitTimestamp
				? "session_operation_conflict"
				: "session_log_write_indeterminate",
			sessionId,
			explicitTimestamp
				? "A legacy Session creation intent cannot verify its explicit timestamp."
				: "A legacy Session creation intent has no persisted timestamp to retry safely.",
			{ offset: 0, operationId, sequence: 1 }
		);
	}
	if (
		creation.createdAtIsExplicit &&
		persistedTimestamp !== creation.createdAt.toISOString()
	) {
		throw new SessionLogError(
			"session_operation_conflict",
			sessionId,
			"A Session creation identity was reused with a different payload.",
			{ offset: 0, operationId, sequence: 1 }
		);
	}
};

const assertSessionCreationOwnership = (
	sessionId: SessionId,
	operationId: string,
	workspaceId: WorkspaceId,
	pendingIntent: SessionWriteIntent | undefined,
	hasPublishedLog: boolean,
	isBoundToWorkspace: () => boolean,
	isBoundToAnotherWorkspace: () => boolean
): boolean => {
	const boundToWorkspace = isBoundToWorkspace();
	const intentWorkspaceId = pendingIntent?.workspaceId;
	if (
		isBoundToAnotherWorkspace() ||
		(pendingIntent?.type === "session.created" &&
			intentWorkspaceId !== undefined &&
			intentWorkspaceId !== workspaceId)
	) {
		throw new SessionLogError(
			"session_operation_conflict",
			sessionId,
			"Session creation belongs to another Workspace.",
			{
				offset: pendingIntent?.expectedOffset ?? 0,
				operationId,
				sequence: 1,
			}
		);
	}
	if (
		(hasPublishedLog || pendingIntent?.type === "session.created") &&
		!boundToWorkspace &&
		intentWorkspaceId !== workspaceId
	) {
		throw new SessionLogError(
			"session_operation_conflict",
			sessionId,
			"Cannot verify Workspace ownership of this published Session creation.",
			{
				offset: pendingIntent?.expectedOffset ?? 0,
				operationId,
				sequence: 1,
			}
		);
	}
	return boundToWorkspace;
};

const createSessionLog = async (
	logRoot: string,
	sessionId: SessionId,
	creation: SessionCreation,
	fileIo: SessionLogFileIo,
	workspaceId: WorkspaceId,
	isBoundToWorkspace: () => boolean,
	isBoundToAnotherWorkspace: () => boolean,
	bindSessionToWorkspace: () => void
): Promise<CommittedLogEntry> => {
	const safeId = validSessionId(sessionId);
	const operationId = `create-${safeId}`;
	const root = path.resolve(logRoot);
	try {
		await ensureDirectoryDurable(root);
	} catch (error) {
		throw new SessionLogError(
			"session_log_write_not_committed",
			sessionId,
			"Session creation could not prepare its authoritative log root.",
			{ cause: error, operationId }
		);
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = await fs.realpath(root);
	} catch (error) {
		throw new SessionLogError(
			"session_log_write_not_committed",
			sessionId,
			"Session creation could not resolve its authoritative log root.",
			{ cause: error, operationId }
		);
	}
	const targetPath = resolveSessionLogFilePath(canonicalRoot, sessionId);
	const pendingIntent = await readSessionWriteIntent(
		logRoot,
		sessionId,
		fileIo
	);
	const existingLog = await readExistingSessionLog(targetPath, sessionId);
	const boundToWorkspace = assertSessionCreationOwnership(
		sessionId,
		operationId,
		workspaceId,
		pendingIntent,
		existingLog !== undefined,
		isBoundToWorkspace,
		isBoundToAnotherWorkspace
	);
	const existingCreation = existingLog?.state.entries.find(
		({ envelope }) =>
			envelope.operationId === operationId &&
			envelope.type === "session.created"
	)?.envelope.payload;
	const { createdAt, lastMessageAt } = sessionCreationTimestamps(
		creation,
		pendingIntent,
		existingCreation,
		operationId
	);
	assertCreationIntentTimestampMatches(
		creation,
		pendingIntent,
		existingCreation,
		operationId,
		sessionId
	);
	const payload = {
		createdAt,
		editMode: creation.editMode,
		lastMessageAt,
		model: creation.model,
		pinned: creation.pinned,
		thinkingLevel: creation.thinkingLevel,
		title: creation.title,
		...omitUndefined({ initialRecord: creation.initialRecord }),
	};
	const operation: SessionWrite = {
		operationId,
		payload,
		type: "session.created",
	};
	const creationIntent: SessionWriteIntent & Readonly<{ timestamp: string }> = {
		expectedOffset: 0,
		operationDigest: creationDigest(operation.payload),
		operationId,
		sequence: 1,
		sessionId,
		timestamp: createdAt,
		type: "session.created",
		workspaceId,
	};
	if (pendingIntent !== undefined) {
		assertSameSessionWriteIntent(
			pendingIntent,
			creationIntent,
			sessionId,
			pendingIntent.type === "session.created" &&
				pendingIntent.workspaceId === undefined &&
				boundToWorkspace
		);
	}
	const withDurableReceipt = async (
		createdNew: boolean,
		entry: SessionLogEntry,
		state: SessionLogState,
		intent: SessionWriteIntent | undefined
	): Promise<CommittedLogEntry> => {
		try {
			await ensureDurableReceipt(logRoot, sessionId, entry, fileIo);
			if (intent !== undefined) {
				await clearSessionWriteIntent(logRoot, intent, fileIo);
			}
			return { createdNew, entry, receiptBlocked: false, state };
		} catch (error) {
			if (
				error instanceof SessionLogError &&
				error.code === "session_operation_conflict"
			) {
				throw error;
			}
			return {
				createdNew,
				entry,
				receiptBlocked: true,
				receiptCause: error,
				state,
			};
		}
	};

	if (existingLog !== undefined) {
		const previous = findCreationOperation(
			existingLog.state,
			operation,
			sessionId
		);
		if (previous !== undefined) {
			await syncAndVerifyLogPrefix(
				targetPath,
				existingLog.bytes,
				sessionId,
				fileIo
			);
			await withSessionCatalogLifecycleGate(canonicalRoot, async () => {
				assertSessionCreationOwnership(
					sessionId,
					operationId,
					workspaceId,
					pendingIntent,
					true,
					isBoundToWorkspace,
					isBoundToAnotherWorkspace
				);
				bindSessionToWorkspace();
			});
			return await withDurableReceipt(
				false,
				previous,
				existingLog.state,
				pendingIntent
			);
		}
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Published Session log is missing its creation event."
		);
	}

	const header = createSessionLogHeader(sessionId, randomUUIDv7(), createdAt);
	const createdEnvelope = createSessionLogEvent({
		operationId: operation.operationId,
		payload: operation.payload,
		previousHash: header.entryHash,
		sequence: 1,
		sessionId,
		timestamp: createdAt,
		type: "session.created",
	});
	const bytes = new Uint8Array([
		...encodeSessionLogLine(header),
		...encodeSessionLogLine(createdEnvelope),
	]);
	const staged = await stageSessionLog(
		canonicalRoot,
		sessionId,
		operation.operationId,
		bytes,
		fileIo
	);
	const intent: SessionWriteIntent & Readonly<{ timestamp: string }> =
		pendingIntent === undefined
			? creationIntent
			: {
					...pendingIntent,
					timestamp: pendingIntent.timestamp ?? creationIntent.timestamp,
				};
	let published = false;
	try {
		await writeSessionWriteIntent(logRoot, intent, fileIo);
		await withSessionCatalogLifecycleGate(canonicalRoot, async () => {
			await publishSessionFileNoReplaceDurably(
				staged.filePath,
				targetPath,
				async (directory) => await syncDirectory(directory, fileIo),
				fileIo.syncDirectory !== undefined,
				() => {
					published = true;
				}
			);
			await syncDirectoryAfterDurablePublication(staged.root, fileIo);
			bindSessionToWorkspace();
		});
		const { bytes: publishedBytes, state } = await readLog(
			targetPath,
			sessionId
		);
		await syncAndVerifyLogPrefix(targetPath, publishedBytes, sessionId, fileIo);
		const entry = state.entries[1];
		if (entry === undefined) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				"Published Session log is missing its creation event."
			);
		}
		return await withDurableReceipt(true, entry, state, intent);
	} catch (error) {
		if (published) {
			if (
				error instanceof SessionLogError &&
				error.code === "session_operation_conflict"
			) {
				throw error;
			}
			throw indeterminateLogWriteError(sessionId, intent, error);
		}
		if (error instanceof SessionLogError) {
			throw error;
		}
		throw new SessionLogError(
			"session_log_write_not_committed",
			sessionId,
			"Session creation was not published to the authoritative log.",
			{ cause: error, operationId: operation.operationId }
		);
	} finally {
		await fs.rm(staged.filePath, { force: true }).catch(() => undefined);
	}
};

const serializeWrite = <Result>(
	key: string,
	operation: () => Promise<Result>
): Promise<Result> => appendQueue.run(key, operation);

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

const toReceipt = (
	entry: SessionLogEntry,
	projection: SessionWriteReceipt["projection"]
): SessionWriteReceipt => ({
	entryHash: entry.envelope.entryHash,
	kind: "committed",
	operationId: entry.envelope.operationId,
	projection,
	sequence: entry.envelope.sequence,
});

const toForkReceipt = (
	entry: SessionLogEntry,
	operationId: string,
	projection: SessionWriteReceipt["projection"]
): SessionWriteReceipt => ({
	...toReceipt(entry, projection),
	operationId,
});

const projectionMatchesState = (
	cursor: SessionProjectionCursor | undefined,
	state: SessionLogState,
	generation: number
): boolean =>
	cursor !== undefined &&
	cursor.generation === generation &&
	cursor.logId === state.logId &&
	cursor.nextSequence === state.nextSequence &&
	cursor.nextByteOffset === state.nextOffset &&
	cursor.lastHash === state.lastHash;

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
		const model = normalizeProviderModelSelection(record.model);
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
): SessionStore => {
	const projection = projectionStore.jsonlProjection;
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
	const writerOperationQueue = createKeyedSerialQueue();

	const withAppendQueues = async <Result>(
		sessionIds: readonly SessionId[],
		operation: () => Promise<Result>
	): Promise<Result> => {
		const keys = await Promise.all(
			[...new Set(sessionIds)]
				.sort()
				.map(async (sessionId) => await lockKey(logRoot, sessionId))
		);
		const acquire = async (index: number): Promise<Result> => {
			const key = keys[index];
			if (key === undefined) {
				return await operation();
			}
			return await appendQueue.run(key, async () => await acquire(index + 1));
		};
		return acquire(0);
	};

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

	const assertSessionWorkspaceBinding = (sessionId: SessionId): void => {
		if (!projection.isBoundToWorkspace(sessionId)) {
			throw new Error("Session not found");
		}
	};

	const assertSessionHistoryWorkspaceBinding = (
		sessionId: SessionId,
		cursor: SessionHistoryPageCursor | undefined
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
		const projectedEntry =
			cursor === undefined ? undefined : state.entries[cursor.nextSequence - 1];
		if (
			cursor !== undefined &&
			(cursor.logId !== state.logId ||
				cursor.nextSequence > state.nextSequence ||
				projectedEntry === undefined ||
				projectedEntry.endOffset !== cursor.nextByteOffset ||
				projectedEntry.envelope.entryHash !== cursor.lastHash)
		) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				"SQLite projection cursor does not match the committed Session log.",
				{
					...omitUndefined({
						offset: cursor?.nextByteOffset,
						sequence:
							cursor === undefined ? undefined : cursor.nextSequence - 1,
					}),
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
				projectionMatchesState(
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
			cursor === undefined ||
			cursor.generation !== projection.getMaintenanceState().generation ||
			cursor.nextSequence !== state.nextSequence ||
			cursor.nextByteOffset !== state.nextOffset ||
			cursor.lastHash !== state.lastHash ||
			cursor.logId !== state.logId
		) {
			throw new SessionLogError(
				"session_projection_blocked",
				sessionId,
				"SQLite projection did not reach the committed Session log head."
			);
		}
	};

	const waitForPendingLogAppend = async (
		sessionId: SessionId,
		attempt: number,
		error: SessionLogError
	): Promise<void> => {
		const markerPath = await sessionWriteIntentPath(logRoot, sessionId);
		let markerExists = true;
		try {
			await fs.access(markerPath);
		} catch (markerError) {
			if (isCode(markerError, "ENOENT")) {
				markerExists = false;
			} else {
				throw markerError;
			}
		}
		if (!markerExists && attempt >= 2) {
			throw error;
		}
		if (attempt >= 100) {
			const intent = await readSessionWriteIntent(logRoot, sessionId, fileIo);
			if (intent !== undefined) {
				throw new SessionLogError(
					"session_log_write_indeterminate",
					sessionId,
					`Session write ${intent.operationId} has an incomplete suffix.`,
					{
						cause: error,
						offset: intent.expectedOffset,
						operationId: intent.operationId,
						sequence: intent.sequence,
					}
				);
			}
			throw error;
		}
		await Bun.sleep(10);
	};

	const readLogForProjection = async (
		logPath: string,
		sessionId: SessionId
	): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await readLog(logPath, sessionId);
			} catch (error) {
				if (
					!(error instanceof SessionLogError) ||
					error.code !== "session_log_truncated"
				) {
					throw error;
				}
				await waitForPendingLogAppend(sessionId, attempt, error);
			}
		}
	};

	const readLogSuffixForProjection = async (
		logPath: string,
		sessionId: SessionId,
		cursor: SessionProjectionCursor
	): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
		for (let attempt = 0; ; attempt += 1) {
			try {
				const { size } = await fs.stat(logPath);
				if (
					!(
						Number.isSafeInteger(size) &&
						Number.isSafeInteger(cursor.nextByteOffset)
					) ||
					cursor.nextByteOffset < 0 ||
					size < cursor.nextByteOffset
				) {
					throw new SessionLogError(
						"session_log_corrupt",
						sessionId,
						"Session projection cursor extends past its authoritative log.",
						{ offset: cursor.nextByteOffset, sequence: cursor.nextSequence }
					);
				}
				const bytes = await Bun.file(logPath)
					.slice(cursor.nextByteOffset, size)
					.bytes();
				if (bytes.byteLength !== size - cursor.nextByteOffset) {
					throw new SessionLogError(
						"session_log_truncated",
						sessionId,
						"Session log changed while its projection suffix was read.",
						{ offset: cursor.nextByteOffset, sequence: cursor.nextSequence }
					);
				}
				const state = decodeSessionLogSuffix(sessionId, bytes, cursor);
				await syncAndVerifyLogSuffix(
					logPath,
					cursor.nextByteOffset,
					bytes,
					sessionId,
					fileIo
				);
				return { bytes, state };
			} catch (error) {
				if (
					!(error instanceof SessionLogError) ||
					error.code !== "session_log_truncated"
				) {
					throw error;
				}
				await waitForPendingLogAppend(sessionId, attempt, error);
			}
		}
	};

	const reconcileVisibleWriteIntent = async (
		sessionId: SessionId,
		logPath: string,
		bytes: Uint8Array,
		state: SessionLogState
	): Promise<void> => {
		const intent = await readSessionWriteIntent(logRoot, sessionId, fileIo);
		if (intent === undefined) {
			return;
		}
		if (
			intent.type === "session.created" &&
			intent.workspaceId !== undefined &&
			intent.workspaceId !== projection.workspaceId
		) {
			throw new SessionLogError(
				"session_operation_conflict",
				sessionId,
				"Session creation belongs to another Workspace.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		const entry = state.entries.find(
			({ envelope }) => envelope.operationId === intent.operationId
		);
		if (entry === undefined) {
			return;
		}
		const entryDigest =
			entry.envelope.type === "session.created"
				? creationDigest(entry.envelope.payload)
				: sessionLogOperationDigest(
						entry.envelope.type,
						entry.envelope.payload
					);
		if (
			entry.envelope.type !== intent.type ||
			entryDigest !== intent.operationDigest ||
			entry.envelope.sequence !== intent.sequence ||
			(intent.type !== "session.created" &&
				entry.startOffset !== intent.expectedOffset)
		) {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Committed Session entry does not match its pending write marker.",
				{
					offset: intent.expectedOffset,
					operationId: intent.operationId,
					sequence: intent.sequence,
				}
			);
		}
		try {
			await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo);
			await ensureDurableReceipt(logRoot, sessionId, entry, fileIo);
			await clearSessionWriteIntent(logRoot, intent, fileIo);
		} catch (error) {
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
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
		const pendingIntent = await readSessionWriteIntent(
			logRoot,
			sessionId,
			fileIo
		);
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

	const reconcileProjectionSessionSidecars = async (
		sessionId: SessionId,
		logPath: string,
		bytes: Uint8Array,
		state: SessionLogState
	): Promise<void> => {
		await reconcileVisibleWriteIntent(sessionId, logPath, bytes, state);
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

	const ensureProjected = async (
		sessionId: SessionId
	): Promise<SessionLogState> => {
		const generation = assertProjectionReady(sessionId);
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
		);
		if (!projection.isBoundToWorkspace(sessionId)) {
			if (projection.isBoundToAnotherWorkspace(sessionId)) {
				throw new Error("Session not found");
			}
			await fs.stat(logPath);
			throw new Error("Session not found");
		}
		await checkDeletedMarker(sessionId);
		for (let attempt = 0; attempt < 5; attempt += 1) {
			let capturedBytes: Uint8Array | undefined;
			try {
				const snapshot = await readLogForProjection(logPath, sessionId);
				capturedBytes = snapshot.bytes;
				const { state } = snapshot;
				await syncAndVerifyLogPrefix(logPath, capturedBytes, sessionId, fileIo);
				await reconcileProjectionSessionSidecars(
					sessionId,
					logPath,
					capturedBytes,
					state
				);
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

	const hasPendingProjectionRecovery = async (
		sessionId: SessionId
	): Promise<boolean> =>
		pendingCreationAttachmentLeases.has(sessionId) ||
		pendingAttachmentLeases.has(sessionId) ||
		(await readSessionWriteIntent(logRoot, sessionId, fileIo)) !== undefined;

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
		logPath: string,
		sessionId: SessionId,
		cursor: SessionProjectionCursor
	): Promise<
		Readonly<{ bytes: Uint8Array; state: SessionLogState }> | undefined
	> => {
		try {
			return await readLogSuffixForProjection(logPath, sessionId, cursor);
		} catch {
			return;
		}
	};

	const suffixNeedsFullProjectionReplay = (state: SessionLogState): boolean =>
		state.entries.length === 0 ||
		state.entries.some(({ envelope }) =>
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
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
		);
		await reconcileDeletedSessionIfNeeded(sessionId);
		await assertProjectionSessionBound(sessionId, logPath);
		await checkDeletedMarker(sessionId);
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
		const suffix = await tryReadProjectionSuffix(logPath, sessionId, cursor);
		if (suffix === undefined || suffixNeedsFullProjectionReplay(suffix.state)) {
			await ensureProjected(sessionId);
			return;
		}
		if (!projectProjectionSuffix(sessionId, cursor, suffix.state)) {
			await ensureProjected(sessionId);
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
			await ensureProjected(sessionId);
		} catch {
			// The retained lease remains available to a later authoritative read.
		}
	};

	const ensureReceipt = async (
		sessionId: SessionId,
		entry: SessionLogEntry
	): Promise<void> => {
		try {
			await ensureDurableReceipt(logRoot, sessionId, entry, fileIo);
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
				projectionMatchesState(
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
				await clearSessionWriteIntent(logRoot, intent, fileIo);
			}
			projectCommittedEntry(sessionId, entry, state, cursorBefore);
		} catch (error) {
			if (error instanceof SessionWriteOutcomeError) {
				throw error;
			}
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
	};

	const writeAppendEntry = async (
		sessionId: SessionId,
		logPath: string,
		entryBytes: Uint8Array,
		intent: SessionWriteIntent
	): Promise<void> => {
		let handle: fs.FileHandle | undefined;
		let writeAttempted = false;
		try {
			handle = await fs.open(logPath, "r+");
			if ((await handle.stat()).size !== intent.expectedOffset) {
				throw new Error("Session log changed outside its writer authority.");
			}
			writeAttempted = true;
			await writeFully(
				handle,
				entryBytes,
				intent.expectedOffset,
				logPath,
				fileIo
			);
			await syncFile(logPath, handle, fileIo);
			await handle.close();
			handle = undefined;
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if (!writeAttempted) {
				try {
					await clearSessionWriteIntent(logRoot, intent, fileIo);
				} catch (clearError) {
					throw indeterminateLogWriteError(sessionId, intent, {
						appendError: error,
						markerError: clearError,
					});
				}
				throw new SessionLogError(
					"session_log_write_not_committed",
					sessionId,
					"Session log append failed before writing any bytes.",
					{
						cause: error,
						offset: intent.expectedOffset,
						operationId: intent.operationId,
						sequence: intent.sequence,
					}
				);
			}
			throw indeterminateLogWriteError(sessionId, intent, error);
		}
	};

	const verifyAppendedEntry = async (
		sessionId: SessionId,
		logPath: string,
		envelope: SessionLogEnvelope,
		intent: SessionWriteIntent
	): Promise<Readonly<{ entry: SessionLogEntry; state: SessionLogState }>> => {
		try {
			const { bytes, state } = await readLog(logPath, sessionId);
			await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo);
			const entry = state.entries.at(-1);
			if (
				entry === undefined ||
				entry.envelope.entryHash !== envelope.entryHash
			) {
				throw new Error("Appended Session log entry could not be verified.");
			}
			return { entry, state };
		} catch (error) {
			throw indeterminateLogWriteError(sessionId, intent, error);
		}
	};

	const repairPendingAppendTail = async (
		sessionId: SessionId,
		logPath: string,
		intent: SessionWriteIntent
	): Promise<void> => {
		const bytes = await Bun.file(logPath).bytes();
		try {
			await quarantinePartialLogAppend(
				logRoot,
				logPath,
				sessionId,
				intent,
				bytes,
				fileIo
			);
		} catch (repairError) {
			if (
				repairError instanceof SessionLogError &&
				(repairError.code === "session_log_corrupt" ||
					repairError.code === "session_log_write_indeterminate")
			) {
				throw repairError;
			}
			throw indeterminateLogWriteError(sessionId, intent, repairError);
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
		await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo);
		try {
			await ensureReceipt(sessionId, entry);
			if (intent.type !== "session.deleted") {
				await clearSessionWriteIntent(logRoot, intent, fileIo);
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
			loaded = await readLog(logPath, sessionId);
		} catch (error) {
			if (
				!(error instanceof SessionLogError) ||
				error.code !== "session_log_truncated"
			) {
				throw error;
			}
			await repairPendingAppendTail(sessionId, logPath, intent);
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
		await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo);
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
				await clearSessionWriteIntent(logRoot, intent, fileIo);
			}
		} catch (error) {
			throw new SessionWriteOutcomeError(toReceipt(entry, "blocked"), error);
		}
		return { createdNew: false, entry, receiptBlocked: false, state };
	};

	const stateAfterProjectionCatchup = async (
		sessionId: SessionId,
		logPath: string,
		write: SessionWrite,
		pendingIntent: SessionWriteIntent | undefined
	): Promise<SessionLogState> => {
		try {
			return await ensureProjected(sessionId);
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
				({ state } = await readLog(logPath, sessionId));
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
			const logPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				sessionId
			);
			const { state } = await readLog(logPath, sessionId);
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
				state: await ensureProjected(sessionId),
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
					}
				: { ...pendingIntent, timestamp };
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
			await writeSessionWriteIntent(logRoot, intent, fileIo);
		}
		await writeAppendEntry(
			sessionId,
			logPath,
			encodeSessionLogLine(envelope),
			intent
		);
		const verified = await verifyAppendedEntry(
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
				await clearSessionWriteIntent(logRoot, intent, fileIo);
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
		const key = await lockKey(logRoot, sessionId);
		return serializeWrite(key, async () => {
			const logPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				sessionId
			);
			const pendingIntent = await readSessionWriteIntent(
				logRoot,
				sessionId,
				fileIo
			);
			if (pendingIntent !== undefined) {
				const recovered = await reconcilePendingAppend(
					sessionId,
					logPath,
					write,
					pendingIntent
				);
				if (recovered !== undefined) {
					const { state } = await readLog(logPath, sessionId);
					return {
						logId: state.logId,
						receipt: deletionReceiptFromEntry(recovered),
					};
				}
			}
			const { bytes, state } = await readLog(logPath, sessionId);
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

	const append = async (
		sessionId: SessionId,
		write: SessionWrite
	): Promise<CommittedLogEntry> => {
		const key = await lockKey(logRoot, sessionId);
		return serializeWrite(key, async () => {
			const logPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				sessionId
			);
			const pendingIntent = await readSessionWriteIntent(
				logRoot,
				sessionId,
				fileIo
			);
			if (pendingIntent !== undefined) {
				const recovered = await reconcilePendingAppend(
					sessionId,
					logPath,
					write,
					pendingIntent
				);
				if (recovered !== undefined) {
					return projectRecoveredOperation(sessionId, recovered);
				}
			}

			const stateBefore = await stateAfterProjectionCatchup(
				sessionId,
				logPath,
				write,
				pendingIntent
			);
			const cursorBefore = projection.getCursor(sessionId);
			const { bytes, state } = await readLog(logPath, sessionId);
			if (state.lastHash !== stateBefore.lastHash) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"Session log changed after projection catch-up."
				);
			}
			const previous = await committedOperation(
				sessionId,
				write,
				state,
				pendingIntent
			);
			if (previous !== undefined) {
				return previous;
			}
			return appendNewOperation(
				sessionId,
				logPath,
				write,
				bytes,
				state,
				cursorBefore,
				pendingIntent
			);
		});
	};

	const withTemporaryWriter = async <Result>(
		sessionId: SessionId,
		operation: () => Promise<Result>,
		onWriterReleaseFailure?: (error: unknown) => Error,
		reuseHeldWriter = true,
		onOperationEnqueued?: () => void
	): Promise<Result> => {
		const key = await lockKey(logRoot, sessionId);
		const queuedOperation = writerOperationQueue.run(key, async () => {
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
		assertProjectionReady(sessionId);
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
		signal?: AbortSignal
	) => {
		throwIfAborted(signal, "Session bundle export was cancelled.");
		assertProjectionReady(sessionId);
		await assertSessionWritable(sessionId);
		const pendingIntent = await readSessionWriteIntent(
			logRoot,
			sessionId,
			fileIo
		);
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
			({ bytes, state } = await readLog(logPath, sessionId));
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
		const generation = assertProjectionReady(sessionId);
		const cursor = projection.getCursor(sessionId);
		assertCursorDoesNotExceedLog(sessionId, cursor, state);
		if (!projectionMatchesState(cursor, state, generation)) {
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
		const attachmentStore = projectionStore.attachmentStore;
		if (checked.attachments.length > 0 && attachmentStore === undefined) {
			throw new SessionBundleValidationError(
				"Session attachment storage is unavailable for bundle export."
			);
		}
		return {
			attachments: checked.attachments,
			cut: { hash: state.lastHash, sequence: state.nextSequence - 1 },
			...omitUndefined({ resolveAttachment: attachmentStore?.resolve }),
			logBytes: bytes,
			logId: state.logId,
			sessionId,
		};
	};

	const withSessionBundleExport = async <Result>(
		sessionId: SessionId,
		operation: (source: PreparedSessionBundleExport) => Promise<Result>,
		options: Readonly<{ existingHostWriter: boolean; signal?: AbortSignal }>
	): Promise<Result> =>
		withTemporaryWriter(
			sessionId,
			async () => {
				throwIfAborted(options.signal, "Session bundle export was cancelled.");
				const source = await readSessionBundleExportSnapshot(
					sessionId,
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
		if ((await readDeletedMarker(logRoot, sessionId)) !== undefined) {
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
		await ensureProjected(sessionId);
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
			await ensureProjected(sessionId);
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
			await publishSessionFileNoReplaceDurably(
				staged.filePath,
				targetPath,
				async (directory) => await syncDirectory(directory, fileIo),
				fileIo.syncDirectory !== undefined,
				() => {
					publication.logPublished = true;
				}
			);
			await syncDirectoryAfterDurablePublication(staged.root, fileIo);
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
			await ensureProjected(sessionId);
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
				await ensureProjected(sessionId);
				return { activationPending: false, sessionId, status: "unchanged" };
			}
			projection.bindSessionToWorkspace(sessionId);
			await ensureProjected(sessionId);
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
				await ensureProjected(sessionId);
				const logPath = resolveSessionLogFilePath(
					await fs.realpath(logRoot),
					sessionId
				);
				const { state } = await readLog(logPath, sessionId);
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
				await ensureProjected(sessionId);
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
			if (projectionMatchesState(cursor, created.state, generation)) {
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
			assertProjectionAtLogHead(
				sessionId,
				projection.getCursor(sessionId),
				created.state
			);
			return toReceipt(created.entry, "ready");
		} catch {
			if (
				projectionMatchesState(
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
				assertProjectionReady(sessionId);
				await assertSessionWritable(sessionId);
				const created = await createSessionLog(
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
				assertProjectionReady(sessionId);
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
					const created = await createSessionLog(
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
		key: string
	): PluginSessionStateRecord | undefined => {
		let current: PluginSessionStateRecord | undefined;
		for (const { envelope } of entries) {
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
		const state = await ensureProjected(sessionId);
		return pluginSessionStateFor(state.entries, pluginId, key);
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
				const state = await ensureProjected(sessionId);
				const existingOperation = findOperation(state, write, sessionId);
				if (existingOperation === undefined) {
					const previous = pluginSessionStateFor(state.entries, pluginId, key);
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
					const committed = await append(sessionId, write);
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
			pendingAppend?.state ?? (await ensureProjected(input.sessionId));
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
		sessionId: SessionId
	): void => {
		if (
			pendingIntent?.operationId !== operationId ||
			pendingIntent.type !== "compaction.committed"
		) {
			return;
		}
		assertSameSessionWriteIntent(
			pendingIntent,
			{
				operationDigest: sessionLogOperationDigest(
					"compaction.committed",
					payload
				),
				operationId,
				type: "compaction.committed",
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
			assertProjectionReady(input.sessionId);
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
				input.sessionId
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
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
		);
		const pendingIntent = await readSessionWriteIntent(
			logRoot,
			sessionId,
			fileIo
		);
		if (pendingIntent?.operationId === operationId) {
			const { state } = await readLog(logPath, sessionId);
			const writeOutcome = await commitWrite(sessionId, {
				operationId,
				payload: {},
				type: "session.deleted",
			});
			return writeOutcome.kind === "committed"
				? { logId: state.logId, receipt: writeOutcome }
				: { writeOutcome };
		}
		const { state } = await readLog(logPath, sessionId);
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
		const pendingIntent = await readSessionWriteIntent(
			logRoot,
			sessionId,
			fileIo
		);
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
		await clearSessionWriteIntent(logRoot, pendingIntent, fileIo);
	};

	const removeDeletedSessionLog = async (
		sessionId: SessionId,
		marker: Readonly<{ logId: string; receipt: SessionDeletionReceipt }>
	): Promise<Readonly<{ logRemoved: boolean; markerDurable: boolean }>> => {
		let markerDurable = false;
		try {
			await ensureDirectoryDurable(logRoot);
			const root = await fs.realpath(logRoot);
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
			const sessionLogPath = resolveSessionLogFilePath(root, sessionId);
			const removeFile = fileIo.remove;
			await removeSessionFileDurably(
				sessionLogPath,
				root,
				async (directory) => await syncDirectory(directory, fileIo),
				removeFile === undefined
					? undefined
					: async (filePath) => await removeFile(filePath, { force: true })
			);
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
						const marker = await readDeletedMarker(logRoot, sessionId);
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
			const intent = await readSessionWriteIntent(logRoot, sessionId, fileIo);
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
			const marker = await readDeletedMarker(logRoot, sessionId);
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

	const resetSessionLog = async (
		root: string,
		sessionId: SessionId
	): Promise<void> => {
		const sessionLogPath = resolveSessionLogFilePath(root, sessionId);
		const existingMarker = await readDeletedMarker(logRoot, sessionId);
		let logId: string;
		let receipt: SessionDeletionReceipt;
		if (existingMarker === undefined) {
			const deletion = await appendResetDeletion(sessionId);
			logId = deletion.logId;
			receipt = deletion.receipt;
			await writeDeletedMarker(logRoot, sessionId, logId, receipt, fileIo);
		} else {
			logId = existingMarker.logId;
			receipt = existingMarker;
			await writeDeletedMarker(logRoot, sessionId, logId, receipt, fileIo);
		}
		await clearPendingDeletionWriteIntent(sessionId, receipt.operationId);
		const removeFile = fileIo.remove;
		await removeSessionFileDurably(
			sessionLogPath,
			root,
			async (directory) => await syncDirectory(directory, fileIo),
			removeFile === undefined
				? undefined
				: async (filePath) => await removeFile(filePath, { force: true })
		);
	};

	const resetSessionLogForLifecycle = async (
		root: string,
		sessionId: SessionId
	): Promise<void> => {
		try {
			await resetSessionLog(root, sessionId);
		} catch (error) {
			const marker = await readDeletedMarker(logRoot, sessionId);
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
		root: string,
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
			await resetSessionLogForLifecycle(root, sessionId);
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
				const root = await fs.realpath(logRoot);
				resetCompleted = await withSessionCatalogLifecycleGate(logRoot, () =>
					resetSessionDataUnderCatalogGate(root, lockedSessionIds)
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

	const wrapRead =
		<Args extends readonly unknown[], Result>(
			read: (...args: Args) => Promise<Result>
		): ((...args: Args) => Promise<Result>) =>
		async (...args) => {
			const sessionId = args[0];
			if (typeof sessionId === "string") {
				try {
					await reconcileDeletedSessionIfNeeded(sessionId as SessionId);
					await ensureProjected(sessionId as SessionId);
				} catch (error) {
					if (!isCode(error, "ENOENT")) {
						throw error;
					}
					const projected = await projectionStore.listSessions();
					if (projected.some((session) => session.id === sessionId)) {
						throw new SessionLogError(
							"session_log_corrupt",
							sessionId as SessionId,
							"A projected Session is missing its authoritative JSONL log."
						);
					}
				}
			}
			return read(...args);
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
				await ensureProjected(sessionId);
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

	const ensureBoundSessionProjectedIfStale = async (
		sessionId: SessionId
	): Promise<void> => {
		await reconcileDeletedSessionIfNeeded(sessionId);
		const generation = assertProjectionReady(sessionId);
		assertSessionWorkspaceBinding(sessionId);
		await checkDeletedMarker(sessionId);
		await ensureDirectoryDurable(logRoot);
		const logPath = resolveSessionLogFilePath(
			await fs.realpath(logRoot),
			sessionId
		);
		const cursor = projection.getCursor(sessionId);
		try {
			const { size } = await fs.stat(logPath);
			if (
				cursor !== undefined &&
				cursor.generation === generation &&
				cursor.nextByteOffset === size
			) {
				return;
			}
		} catch (error) {
			if (!isCode(error, "ENOENT")) {
				throw error;
			}
		}
		await ensureCatalogSessionProjected(sessionId);
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
			const intent = await readSessionWriteIntent(logRoot, sessionId, fileIo);
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

	const ensureBoundCatalogLogsProjected = async (): Promise<void> => {
		await ensureDirectoryDurable(logRoot);
		const root = await fs.realpath(logRoot);
		await assertNoUnresolvedOwnedSessionCreations(root);
		const generation = projection.getMaintenanceState().generation;
		for (const sessionId of projection.listBoundSessionIds()) {
			const logPath = resolveSessionLogFilePath(root, sessionId);
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
	const ensureRecentModelSelectionsProjected = async (
		sessionIds: readonly SessionId[]
	): Promise<void> => {
		for (const sessionId of sessionIds) {
			await reconcileDeletedSessionIfNeeded(sessionId);
			await ensureProjected(sessionId);
		}
	};
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
		await ensureDeletedSessionsReconciled();
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
			await ensureBoundCatalogLogsProjected();
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
		await ensureDeletedSessionsReconciled();
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
		if (cursor === undefined) {
			await ensureBoundSessionProjectedIfStale(sessionId);
		}
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
			const page = projectionStore.readSessionHistoryPageProjection(sessionId, {
				...(cursor === undefined ? {} : { cursor }),
				limit,
			});
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
		return forkOperationQueue.run(
			`${sourceKey}\0fork\0${operationId}`,
			async () => {
				const existingIntent = await withSessionCatalogLifecycleGate(
					logRoot,
					async () => {
						const existing = await readSessionForkIntent(
							logRoot,
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
							await clearSessionWriteIntent(logRoot, createdIntent, fileIo);
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
						await ensureProjected(targetSessionId);
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
					assertProjectionReady(sourceSessionId);
					await assertSessionWritable(sourceSessionId);
					const sourceState = await ensureProjected(sourceSessionId);
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
					const sourcePrefixEntries = sourceState.entries.filter(
						({ envelope }) =>
							envelope.sequence <= checkpointEntry.envelope.sequence
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
					const identityMap = createSessionForkIdentityMap(
						targetSessionId,
						sourceRecords,
						sourceCompactions.map(({ id }) => id)
					);
					const copiedSourceCompactionIds = new Set<string>();
					const remappedCompactions = new Map<
						string,
						SessionCompactionPayload
					>();
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
					const targetCheckpointRecord = remappedRecords.get(
						checkpointRecord.id
					);
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
						initialRecord: _sourceInitialRecord,
						...sourceCreationPayload
					} = sourceCreatedEntry.envelope.payload;
					const creationPayload = {
						...sourceCreationPayload,
						createdAt,
						...omitUndefined({ initialRecord: targetInitialRecord }),
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
						inheritedUsage: remapForkUsageTurnIds(
							inheritedUsageAtFork(
								sourcePrefixEntries,
								sourceRecords,
								sourceSessionId
							),
							identityMap
						),
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
						if (
							entry.envelope.type === "plugin.state-replaced" ||
							entry.envelope.type === "plugin.state-deleted"
						) {
							appendLine(
								createSessionLogEvent({
									operationId: `fork-plugin-state-${entry.envelope.sequence}`,
									payload: entry.envelope.payload,
									previousHash,
									sequence: nextSequence,
									sessionId: targetSessionId,
									timestamp: entry.envelope.timestamp,
									type: entry.envelope.type,
								})
							);
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
							const recordEnvelope = createSessionLogEvent({
								operationId: `record-${record.id}`,
								payload: {
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
							continue;
						}
						if (entry.envelope.type === "compaction.committed") {
							const sourceCompaction = parseSessionCompactionPayload(
								entry.envelope.payload
							);
							const compaction = remappedCompactions.get(sourceCompaction.id);
							if (compaction !== undefined) {
								appendLine(
									createSessionLogEvent({
										operationId: `compaction-${compaction.id}`,
										payload: compaction,
										previousHash,
										sequence: nextSequence,
										sessionId: targetSessionId,
										timestamp: entry.envelope.timestamp,
										type: "compaction.committed",
									})
								);
							}
							continue;
						}
						if (entry.envelope.type === "context.edited") {
							const edit = sessionContextEditSchema.parse(
								entry.envelope.payload
							);
							const targetId = identityMap.messages.get(edit.targetId);
							if (targetId !== undefined) {
								const editOperationId = isFailedAttemptContextEdit(
									edit.operationId
								)
									? `${FAILED_ATTEMPT_CONTEXT_EDIT_OPERATION_PREFIX}fork-${entry.envelope.sequence}`
									: `fork-context-${entry.envelope.sequence}`;
								appendLine(
									createSessionLogEvent({
										operationId: editOperationId,
										payload: {
											...edit,
											operationId: editOperationId,
											targetId,
										},
										previousHash,
										sequence: nextSequence,
										sessionId: targetSessionId,
										timestamp: entry.envelope.timestamp,
										type: "context.edited",
									})
								);
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
									const existing = await readSessionForkIntent(
										logRoot,
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
									const created = await writeSessionForkIntent(
										logRoot,
										forkIntentCandidate,
										sourceSessionId,
										fileIo
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
						await writeSessionWriteIntent(logRoot, createdIntent, fileIo);
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
							await publishSessionFileNoReplaceDurably(
								stagedLog.filePath,
								targetLogPath,
								async (directory) => await syncDirectory(directory, fileIo),
								fileIo.syncDirectory !== undefined,
								() => {
									published = true;
								}
							);
							await syncDirectoryAfterDurablePublication(
								stagedLog.root,
								fileIo
							);
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
							await clearSessionWriteIntent(logRoot, createdIntent, fileIo);
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
							projectionReady = projectionMatchesState(
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
								await clearSessionWriteIntent(logRoot, createdIntent, fileIo);
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
			}
		);
	};
	const forkSession: SessionStore["forkSession"] = (
		sourceSessionId,
		checkpoint,
		operationId
	) => runForkSession(sourceSessionId, checkpoint, operationId, false);
	const forkSessionWithHeldWriter: SessionStore["forkSessionWithHeldWriter"] = (
		sourceSessionId,
		checkpoint,
		operationId
	) => runForkSession(sourceSessionId, checkpoint, operationId, true);

	const getSessionForkProvenance: SessionStore["getSessionForkProvenance"] =
		async (sessionId) => {
			await ensureBoundSessionProjectedIfStale(sessionId);
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
					const sourceLog = await readLogForProjection(
						resolveSessionLogFilePath(
							await fs.realpath(logRoot),
							provenance.sourceSessionId
						),
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
	const getOrCreateSessionForkActionId: SessionStore["getOrCreateSessionForkActionId"] =
		async (sourceSessionId, checkpoint) =>
			withSessionCatalogLifecycleGate(logRoot, async () => {
				const existing = await readSessionForkAction(
					logRoot,
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
				const created = await writeSessionForkAction(
					logRoot,
					candidate,
					checkpoint,
					fileIo
				);
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
	const completeSessionForkAction: SessionStore["completeSessionForkAction"] = (
		sourceSessionId,
		checkpoint,
		operationId
	) =>
		withSessionCatalogLifecycleGate(logRoot, () =>
			clearSessionForkAction(
				logRoot,
				sourceSessionId,
				checkpoint,
				operationId,
				fileIo
			)
		);

	const getSessionStatistics: SessionStore["getSessionStatistics"] = async (
		sessionId,
		options: SessionStatisticsOptions = {}
	): Promise<SessionStatistics> => {
		const requestedReadPoint =
			options.readPoint === undefined
				? undefined
				: decodeSessionHistoryReadPointToken(options.readPoint);
		if (requestedReadPoint === undefined) {
			await ensureBoundSessionProjectedIfStale(sessionId);
		}
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
				sessionId,
				summary: statisticsProjection.summary,
				...(options.turnId === undefined ? {} : { turnId: options.turnId }),
				usageEntries: statisticsProjection.usageEntries,
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
		const marker = await readDeletedMarker(logRoot, sessionId);
		const pendingIntent = await readSessionWriteIntent(
			logRoot,
			sessionId,
			fileIo
		);
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

	const ensureDeletedSessionsReconciled = async (): Promise<void> => {
		const issues = await reconcileDeletedSessions();
		const firstIssue = issues[0];
		if (firstIssue !== undefined) {
			throw Object.assign(new Error(firstIssue.message), {
				code: firstIssue.code,
				sessionId: firstIssue.sessionId,
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
		const { bytes, state } = await readLogForProjection(logPath, sessionId);
		if (
			state.entries.some(({ envelope }) => envelope.type === "session.deleted")
		) {
			throw new SessionLogError(
				"session_deleted",
				sessionId,
				"Session deletion must be reconciled before projection rebuild."
			);
		}
		await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo);
		await reconcileVisibleWriteIntent(sessionId, logPath, bytes, state);
		const cursor = projection.getCursor(sessionId);
		projection.projectEntries(
			sessionId,
			state.entries,
			state,
			cursor,
			"maintenance"
		);
		assertProjectionAtLogHead(
			sessionId,
			projection.getCursor(sessionId),
			state
		);
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

	const rebuildProjection: SessionStore["rebuildProjection"] = (scope, gate) =>
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
			const unresolvedIntent = await readSessionWriteIntent(
				logRoot,
				sessionId,
				fileIo
			);
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
				projectionMatchesState(
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
			await ensureDurableReceipt(logRoot, sessionId, match.entry, fileIo);
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
			assertProjectionReady(sessionId);
			await checkDeletedMarker(sessionId);
			const logPath = resolveSessionLogFilePath(
				await fs.realpath(logRoot),
				sessionId
			);
			const { bytes, state } = await readLogForProjection(logPath, sessionId);
			await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo);
			try {
				await reconcileVisibleWriteIntent(sessionId, logPath, bytes, state);
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
		...projectionStore,
		acquireSessionWriter: acquireWriter,
		appendContextEdit,
		appendCompaction,
		commitSessionRecord,
		getPluginSessionState,
		mutatePluginSessionState,
		createEmptySession,
		createSession,
		createSessionWithExternalizedMessage,
		createSessionUsageEntry,
		deleteSession,
		findSessionRecordBySubmissionId,
		forkSession,
		forkSessionWithHeldWriter,
		getOrCreateSessionForkActionId,
		completeSessionForkAction,
		getSessionForkProvenance,
		getCompactions: wrapRead(projectionStore.getCompactions),
		getLatestCompaction: wrapRead(projectionStore.getLatestCompaction),
		getSession: wrapRead(projectionStore.getSession),
		...(projectionStore.getEditMode === undefined
			? {}
			: { getEditMode: wrapRead(projectionStore.getEditMode) }),
		listSessionCatalog,
		listRecentModelSelections,
		listSessionRecords: wrapRead(projectionStore.listSessionRecords),
		listSessionsPage,
		readSessionHistoryPage,
		getSessionStatistics,
		listSessionUsageEntries: wrapRead(projectionStore.listSessionUsageEntries),
		listSessions,
		withSessionBundleExport,
		withSessionBundleImport: importSessionBundle,
		isSessionImportActivationPending,
		isSessionImported,
		confirmSessionImportActivation,
		rebuildProjection,
		resetSessionData,
		setEditMode,
		updateSession,
		updateSessionSubmission,
	};
};

type SessionDeletionReceipt = Readonly<{
	entryHash: string;
	operationId: string;
	sequence: number;
}>;

function deletionReceiptFromEntry(
	entry: SessionLogEntry
): SessionDeletionReceipt {
	if (entry.envelope.type !== "session.deleted") {
		throw new Error("Session reset did not produce a deletion event.");
	}
	return {
		entryHash: entry.envelope.entryHash,
		operationId: entry.envelope.operationId,
		sequence: entry.envelope.sequence,
	};
}

type SessionDeletionMarker = SessionDeletionReceipt &
	Readonly<{ logId: string }>;

type SessionImportActivationMarker = Readonly<{
	activationOperationId: string;
	bundleIdentity: string;
	cutHash: string;
	cutSequence: number;
	logId: string;
	sessionId: SessionId;
	version: 1;
	workspaceId: WorkspaceId;
}>;

const sessionImportActivationMarkerPath = async (
	logRoot: string,
	sessionId: SessionId
): Promise<string> =>
	path.join(
		await sessionControlRoot(logRoot),
		"imports",
		`${validSessionId(sessionId)}.json`
	);

const readSessionImportActivationMarker = async (
	logRoot: string,
	sessionId: SessionId
): Promise<SessionImportActivationMarker | undefined> => {
	const markerPath = await sessionImportActivationMarkerPath(
		logRoot,
		sessionId
	);
	let markerText: string;
	try {
		markerText = await readUtf8File(markerPath);
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(markerText) as unknown;
	} catch (error) {
		throw new SessionBundleImportConflictError(
			"Session import activation marker is invalid.",
			{ cause: error }
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SessionBundleImportConflictError(
			"Session import activation marker is invalid."
		);
	}
	const marker = value as Record<string, unknown>;
	const expectedKeys = [
		"activationOperationId",
		"bundleIdentity",
		"cutHash",
		"cutSequence",
		"logId",
		"sessionId",
		"version",
		"workspaceId",
	].sort();
	if (
		Object.keys(marker).sort().join("\0") !== expectedKeys.join("\0") ||
		marker.version !== 1 ||
		marker.sessionId !== sessionId ||
		typeof marker.workspaceId !== "string" ||
		marker.workspaceId.length === 0 ||
		typeof marker.logId !== "string" ||
		marker.logId.length === 0 ||
		typeof marker.activationOperationId !== "string" ||
		!isValidSessionLogIdentifier(marker.activationOperationId) ||
		typeof marker.bundleIdentity !== "string" ||
		!SESSION_LOG_HASH_PATTERN.test(marker.bundleIdentity) ||
		typeof marker.cutHash !== "string" ||
		!SESSION_LOG_HASH_PATTERN.test(marker.cutHash) ||
		typeof marker.cutSequence !== "number" ||
		!Number.isSafeInteger(marker.cutSequence) ||
		marker.cutSequence < 1
	) {
		throw new SessionBundleImportConflictError(
			"Session import activation marker is invalid."
		);
	}
	return {
		activationOperationId: marker.activationOperationId,
		bundleIdentity: marker.bundleIdentity,
		cutHash: marker.cutHash,
		cutSequence: marker.cutSequence,
		logId: marker.logId,
		sessionId,
		version: 1,
		workspaceId: toWorkspaceId(marker.workspaceId),
	};
};

const writeSessionImportActivationMarker = async (
	logRoot: string,
	marker: SessionImportActivationMarker,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const controlRoot = await sessionControlRoot(logRoot);
	const importRoot = path.join(controlRoot, "imports");
	await ensureDirectoryDurable(controlRoot, 0o700, fileIo);
	await ensureDirectoryDurable(importRoot, 0o700, fileIo);
	const markerPath = await sessionImportActivationMarkerPath(
		logRoot,
		marker.sessionId
	);
	const temporaryPath = `${markerPath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		const bytes = new TextEncoder().encode(
			`${encodeCanonicalSessionJson(marker)}\n`
		);
		await writeFully(handle, bytes, 0, temporaryPath, fileIo);
		await syncFile(temporaryPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		try {
			await publishSessionFileNoReplaceDurably(
				temporaryPath,
				markerPath,
				async (directory) => await syncDirectory(directory, fileIo),
				fileIo.syncDirectory !== undefined
			);
		} catch (error) {
			if (!isCode(error, "EEXIST")) {
				throw error;
			}
			const existing = await readSessionImportActivationMarker(
				logRoot,
				marker.sessionId
			);
			if (
				existing === undefined ||
				existing.bundleIdentity !== marker.bundleIdentity ||
				existing.workspaceId !== marker.workspaceId ||
				existing.logId !== marker.logId ||
				existing.cutHash !== marker.cutHash ||
				existing.cutSequence !== marker.cutSequence
			) {
				throw new SessionBundleImportConflictError(
					"A durable Session import activation marker conflicts with this bundle."
				);
			}
		}
		await fs.rm(temporaryPath, { force: true });
		await syncDirectoryAfterDurablePublication(importRoot, fileIo);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
};

const removeSessionImportActivationMarker = async (
	logRoot: string,
	sessionId: SessionId,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const markerPath = await sessionImportActivationMarkerPath(
		logRoot,
		sessionId
	);
	await removeSessionFileDurably(
		markerPath,
		await sessionControlRoot(logRoot),
		async (directory) => await syncDirectory(directory, fileIo)
	);
};

const readDeletedMarker = async (
	logRoot: string,
	sessionId: SessionId
): Promise<SessionDeletionMarker | undefined> => {
	const markerPath = path.join(
		await sessionControlRoot(logRoot),
		"deleted",
		`${validSessionId(sessionId)}.json`
	);
	let markerText: string;
	try {
		markerText = await fs.readFile(markerPath, "utf8");
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	const value = JSON.parse(markerText) as {
		entryHash?: unknown;
		logId?: unknown;
		operationId?: unknown;
		sequence?: unknown;
		sessionId?: unknown;
	};
	if (
		value.sessionId !== sessionId ||
		value.operationId !== sessionDeletionOperationId(sessionId) ||
		typeof value.entryHash !== "string" ||
		!SESSION_LOG_HASH_PATTERN.test(value.entryHash) ||
		typeof value.logId !== "string" ||
		value.logId.length === 0 ||
		typeof value.sequence !== "number" ||
		!Number.isSafeInteger(value.sequence) ||
		value.sequence < 2
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session deletion marker is invalid."
		);
	}
	return {
		entryHash: value.entryHash,
		logId: value.logId,
		operationId: value.operationId,
		sequence: value.sequence,
	};
};

const writeDeletedMarker = async (
	logRoot: string,
	sessionId: SessionId,
	logId: string,
	receipt: SessionDeletionReceipt,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const controlRoot = await sessionControlRoot(logRoot);
	const deletedRoot = path.join(controlRoot, "deleted");
	await ensureDirectoryDurable(controlRoot);
	await ensureDirectoryDurable(deletedRoot);
	const markerPath = path.join(
		deletedRoot,
		`${validSessionId(sessionId)}.json`
	);
	const bytes = new TextEncoder().encode(
		`${encodeCanonicalSessionJson({
			entryHash: receipt.entryHash,
			logId,
			operationId: receipt.operationId,
			sequence: receipt.sequence,
			sessionId,
		})}\n`
	);
	const temporaryPath = `${markerPath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await writeFully(handle, bytes, 0, temporaryPath, fileIo);
		await syncFile(temporaryPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		await publishSessionFileNoReplaceDurably(
			temporaryPath,
			markerPath,
			async (directory) => await syncDirectory(directory, fileIo),
			fileIo.syncDirectory !== undefined
		);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (!isCode(error, "EEXIST")) {
			throw error;
		}
		const existing = await fs.readFile(markerPath);
		if (!equalBytes(existing, bytes)) {
			throw new SessionLogError(
				"session_operation_conflict",
				sessionId,
				"A durable Session deletion marker conflicts with its operation."
			);
		}
		const existingHandle = await openFileForSync(markerPath);
		try {
			await syncFile(markerPath, existingHandle, fileIo);
		} finally {
			await existingHandle.close();
		}
		await syncDirectoryAfterDurablePublication(deletedRoot, fileIo);
	} finally {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
};

const indeterminateLogWriteError = (
	sessionId: SessionId,
	intent: SessionWriteIntent,
	cause: unknown
): SessionLogError =>
	new SessionLogError(
		"session_log_write_indeterminate",
		sessionId,
		"Session log write outcome is indeterminate; retry the same operation to reconcile it.",
		{
			cause,
			offset: intent.expectedOffset,
			operationId: intent.operationId,
			sequence: intent.sequence,
		}
	);
