import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type SessionRecord,
	type SubmissionId,
	toSessionRecordId,
} from "@wincode/agent-core";
import { omitUndefined } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { EditMode } from "@/modules/tools";
import {
	type CompactionId,
	isValidSessionId,
	type SessionId,
	toCompactionId,
	toSessionId,
	toWorkspaceId,
	type WorkspaceId,
} from "@/shared/identifiers";
import { createKeyedSerialQueue } from "@/shared/utils/keyed-serial-queue";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import { assertCompactionMessageReferences } from "../compaction/validation";
import { buildSessionStatistics } from "../usage/session-statistics";
import type { AttachmentExternalizationLease } from "./attachment-store";
import type { DrizzleSessionStore } from "./drizzle-session-store";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	decodeSessionLog,
	encodeCanonicalSessionJson,
	encodeSessionLogLine,
	SESSION_LOG_EVENT_TYPES,
	SESSION_LOG_HASH_PATTERN,
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

const SESSION_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u;
const sessionDeletionOperationId = (sessionId: SessionId): string =>
	`delete-${validSessionId(sessionId)}`;
const operationIdFileStem = (operationId: string): string =>
	new Bun.CryptoHasher("sha256").update(operationId).digest("hex");

const appendQueue = createKeyedSerialQueue();

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

const syncDirectory = async (
	directory: string,
	fileIo?: SessionLogFileIo
): Promise<void> => {
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

const ensureDirectoryDurable = async (
	directory: string,
	mode = 0o700,
	fileIo?: SessionLogFileIo
): Promise<void> => {
	try {
		await fs.mkdir(directory, { mode });
		await syncDirectory(path.dirname(directory), fileIo);
	} catch (error) {
		if (!isCode(error, "EEXIST")) {
			throw error;
		}
		const info = await fs.stat(directory);
		if (!info.isDirectory()) {
			throw new Error("Session log path is not a directory.");
		}
		await syncDirectory(path.dirname(directory), fileIo);
	}
};

const readLog = async (
	logPath: string,
	sessionId: SessionId
): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
	const bytes = await Bun.file(logPath).bytes();
	return { bytes, state: decodeSessionLog(sessionId, bytes) };
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
};

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
	const logPath = path.join(
		path.resolve(logRoot),
		validSessionId(sessionId),
		"session.jsonl"
	);
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
		!SESSION_OPERATION_ID_PATTERN.test(operationId) ||
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
		handle = await fs.open(markerPath, "r");
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
		await syncDirectory(path.dirname(markerPath));
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
			await fs.rename(temporaryPath, markerPath);
			await syncDirectory(markerRoot);
			return;
		}
		try {
			await fs.link(temporaryPath, markerPath);
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
		await syncDirectory(markerRoot);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (error instanceof SessionLogError) {
			throw error;
		}
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
	try {
		await fs.unlink(markerPath);
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
	}
	await syncDirectory(path.dirname(markerPath));
};

const syncAndVerifyLogPrefix = async (
	logPath: string,
	capturedBytes: Uint8Array,
	sessionId: SessionId,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const handle = await fs.open(logPath, "r");
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
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log changed while its projection was being checked."
		);
	}
};

const ensureDurableQuarantineArtifact = async (
	filePath: string,
	directory: string,
	expectedBytes: Uint8Array,
	sessionId: SessionId,
	intent: SessionWriteIntent,
	fileIo: SessionLogFileIo
): Promise<void> => {
	const temporaryPath = `${filePath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		try {
			handle = await fs.open(filePath, "r");
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
				await fs.link(temporaryPath, filePath);
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
		await syncDirectory(directory, fileIo);
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
		quarantineRoot,
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
		quarantineRoot,
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
	await syncDirectory(path.dirname(logPath));
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
	receiptRoot: string,
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
		await fs.rename(temporaryPath, receiptPath);
		await syncDirectory(receiptRoot);
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
		await publishReceiptReplacement(receiptPath, receiptRoot, bytes, fileIo);
		return;
	}
	let value: unknown;
	try {
		value = JSON.parse(existing);
	} catch {
		await publishReceiptReplacement(receiptPath, receiptRoot, bytes, fileIo);
		return;
	}
	if (!isDurableSessionReceipt(value)) {
		await publishReceiptReplacement(receiptPath, receiptRoot, bytes, fileIo);
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
		handle = await fs.open(receiptPath, "r");
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
		await publishReceiptReplacement(receiptPath, receiptRoot, bytes, fileIo);
		return;
	}
	try {
		await syncFile(receiptPath, handle, fileIo);
	} finally {
		await handle.close();
	}
	await syncDirectory(receiptRoot);
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
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(receiptPath, "wx", 0o600);
		await writeFully(handle, bytes, 0, receiptPath, fileIo);
		await syncFile(receiptPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		await syncDirectory(receiptRoot);
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
	}
};

type StagedSessionLog = Readonly<{
	directory: string;
	root: string;
}>;

const stageSessionLog = async (
	canonicalRoot: string,
	sessionId: SessionId,
	safeId: string,
	operationId: string,
	bytes: Uint8Array,
	fileIo: SessionLogFileIo
): Promise<StagedSessionLog> => {
	const root = path.join(canonicalRoot, ".staging");
	let directory: string | undefined;
	let handle: fs.FileHandle | undefined;
	try {
		await ensureDirectoryDurable(root);
		directory = await fs.mkdtemp(path.join(root, `${safeId}.`));
		const filePath = path.join(directory, "session.jsonl");
		handle = await fs.open(filePath, "wx", 0o600);
		await writeFully(handle, bytes, 0, filePath, fileIo);
		await syncFile(filePath, handle, fileIo);
		await handle.close();
		handle = undefined;
		await syncDirectory(directory);
		return { directory, root };
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (directory !== undefined) {
			await fs
				.rm(directory, { force: true, recursive: true })
				.catch(() => undefined);
		}
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

const createLogDirectory = async (
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
	const targetDirectory = path.join(canonicalRoot, safeId);
	const targetPath = path.join(targetDirectory, "session.jsonl");
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
		safeId,
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
			await fs.rename(staged.directory, targetDirectory);
			published = true;
			await syncDirectory(staged.root, fileIo);
			await syncDirectory(canonicalRoot, fileIo);
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
		await fs
			.rm(staged.directory, { force: true, recursive: true })
			.catch(() => undefined);
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

export const createSessionJsonlStore = (
	projectionStore: DrizzleSessionStore,
	logRoot: string,
	fileIo: SessionLogFileIo = {}
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
		if (intent.type === "session.deleted") {
			throw new SessionLogError(
				"session_log_write_indeterminate",
				sessionId,
				"Session deletion must be reconciled before reopening.",
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
		await checkDeletedMarker(sessionId);
		const logPath = path.join(
			await fs.realpath(logRoot),
			validSessionId(sessionId),
			"session.jsonl"
		);
		if (!projection.isBoundToWorkspace(sessionId)) {
			if (projection.isBoundToAnotherWorkspace(sessionId)) {
				throw new Error("Session not found");
			}
			await fs.stat(logPath);
			throw new Error("Session not found");
		}
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
		const logPath = path.join(
			await fs.realpath(logRoot),
			validSessionId(sessionId),
			"session.jsonl"
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
			await clearSessionWriteIntent(logRoot, intent, fileIo);
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
			await clearSessionWriteIntent(logRoot, intent, fileIo);
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
			if (intent !== undefined) {
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
		pendingIntent: SessionWriteIntent | undefined
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
		await persistReceiptAndProjection(
			sessionId,
			verified.entry,
			verified.state,
			cursorBefore,
			intent
		);
		return {
			createdNew: false,
			entry: verified.entry,
			receiptBlocked: false,
			state: verified.state,
		};
	};

	const append = async (
		sessionId: SessionId,
		write: SessionWrite
	): Promise<CommittedLogEntry> => {
		const key = await lockKey(logRoot, sessionId);
		return serializeWrite(key, async () => {
			const logPath = path.join(
				await fs.realpath(logRoot),
				validSessionId(sessionId),
				"session.jsonl"
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
		operation: () => Promise<Result>
	): Promise<Result> => {
		const key = await lockKey(logRoot, sessionId);
		return writerOperationQueue.run(key, async () => {
			const writer = heldWriterKeys.has(key)
				? undefined
				: await acquireSessionWriterLock(logRoot, sessionId);
			try {
				return await operation();
			} finally {
				await writer?.release();
			}
		});
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

	const projectCreation = (created: CommittedLogEntry): SessionWriteOutcome => {
		if (created.receiptBlocked) {
			return toReceipt(created.entry, "blocked");
		}
		try {
			const cursor = projection.getCursor(created.entry.envelope.sessionId);
			projection.projectEntries(
				created.entry.envelope.sessionId,
				created.state.entries,
				created.state,
				cursor
			);
			return toReceipt(created.entry, "ready");
		} catch {
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
				const created = await createLogDirectory(
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
					const created = await createLogDirectory(
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
		const logPath = path.join(
			path.resolve(logRoot),
			validSessionId(input.sessionId),
			"session.jsonl"
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
		const logPath = path.join(
			await fs.realpath(logRoot),
			validSessionId(sessionId),
			"session.jsonl"
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
			const sessionDirectory = path.join(root, validSessionId(sessionId));
			const remove = fileIo.remove ?? fs.rm;
			await remove(sessionDirectory, { force: true, recursive: true });
			await syncDirectory(root, fileIo);
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
			return await withTemporaryWriter(sessionId, async () => {
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
					throw new Error("The committed Session deletion receipt is missing.");
				}
				return await finalizeDeletion(
					sessionId,
					receipt,
					markerDurable,
					logRemoved
				);
			});
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
	const assertResetAllowed = async (): Promise<void> => {
		const recovery = projectionStore.fileObservationStore?.recovery;
		if (recovery === undefined) {
			return;
		}
		await recovery.ensureReady?.();
		if ((await recovery.listUnresolvedRecoveries()).length > 0) {
			throw new Error(
				"Reset is blocked until every workspace recovery is reconciled or discarded."
			);
		}
	};

	const findSessionLogIds = async (): Promise<SessionId[]> => {
		await ensureDirectoryDurable(logRoot);
		const root = await fs.realpath(logRoot);
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && entry.name !== ".staging")
			.map((entry) => toSessionId(entry.name))
			.sort();
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

	const findResetSessionIds = async (): Promise<SessionId[]> =>
		[
			...new Set([
				...(await findSessionLogIds()),
				...(await findDeletedMarkerSessionIds()),
			]),
		].sort();

	const resetSessionLog = async (
		root: string,
		sessionId: SessionId
	): Promise<void> => {
		const directory = path.join(root, validSessionId(sessionId));
		const existingMarker = await readDeletedMarker(logRoot, sessionId);
		let logId: string;
		let receipt: SessionDeletionReceipt;
		if (existingMarker === undefined) {
			const logPath = path.join(directory, "session.jsonl");
			const { state } = await readLog(logPath, sessionId);
			const writeOutcome = await commitWrite(sessionId, {
				operationId: sessionDeletionOperationId(sessionId),
				payload: {},
				type: "session.deleted",
			});
			if (writeOutcome.kind !== "committed") {
				throw new SessionWriteOutcomeError(writeOutcome);
			}
			logId = state.logId;
			receipt = writeOutcome;
			await writeDeletedMarker(logRoot, sessionId, logId, receipt, fileIo);
		} else {
			logId = existingMarker.logId;
			receipt = existingMarker;
			await writeDeletedMarker(logRoot, sessionId, logId, receipt, fileIo);
		}
		const remove = fileIo.remove ?? fs.rm;
		await remove(directory, { force: true, recursive: true });
		await syncDirectory(root, fileIo);
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
			if (!entry.isDirectory() || entry.name === ".staging") {
				continue;
			}
			const sessionId = toSessionId(entry.name);
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
			await ensureProjected(sessionId);
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
		await checkDeletedMarker(sessionId);
		if (!projection.isBoundToWorkspace(sessionId)) {
			await ensureProjected(sessionId);
			return;
		}
		await ensureDirectoryDurable(logRoot);
		const logPath = path.join(
			await fs.realpath(logRoot),
			validSessionId(sessionId),
			"session.jsonl"
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

	const ensureBoundCatalogLogsProjected = async (): Promise<void> => {
		await ensureDirectoryDurable(logRoot);
		const root = await fs.realpath(logRoot);
		const generation = projection.getMaintenanceState().generation;
		for (const sessionId of projection.listBoundSessionIds()) {
			const logPath = path.join(
				root,
				validSessionId(sessionId),
				"session.jsonl"
			);
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
			const projection = projectionStore.readSessionStatisticsProjection(
				sessionId,
				requestedReadPoint
			);
			return buildSessionStatistics({
				compactions: projection.compactions,
				readPoint: encodeSessionPageToken(projection.readPoint),
				records: projection.records,
				sessionId,
				...(options.turnId === undefined ? {} : { turnId: options.turnId }),
				usageEntries: projection.usageEntries,
			});
		});
	};

	const logHasDeletionEvent = async (
		sessionId: SessionId,
		root: string
	): Promise<boolean> => {
		try {
			const { state } = await readLog(
				path.join(root, sessionId, "session.jsonl"),
				sessionId
			);
			return state.entries.some(
				({ envelope }) => envelope.type === "session.deleted"
			);
		} catch {
			// Invalid logs remain visible to the rebuild as per-Session issues.
			return false;
		}
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

	const reconcileDeletedSessions = async (): Promise<SessionCatalogIssue[]> => {
		const snapshot = await readCatalogSnapshot();
		const root = await fs.realpath(logRoot);
		const deletedSessionIds = new Set(snapshot.deleted);
		for (const sessionId of snapshot.published) {
			if (
				isValidSessionId(sessionId) &&
				!deletedSessionIds.has(sessionId) &&
				(await logHasDeletionEvent(sessionId, root))
			) {
				deletedSessionIds.add(sessionId);
			}
		}
		const issues: SessionCatalogIssue[] = [];
		for (const sessionId of [...deletedSessionIds].sort()) {
			const issue = await reconcileDeletedSession(sessionId);
			if (issue !== undefined) {
				issues.push(issue);
			}
		}
		return issues;
	};

	const reconcileDeletedSessionIfNeeded = async (
		sessionId: SessionId
	): Promise<void> => {
		const marker = await readDeletedMarker(logRoot, sessionId);
		const hasDeletionEvent =
			marker !== undefined ||
			(await logHasDeletionEvent(sessionId, await fs.realpath(logRoot)));
		if (!hasDeletionEvent) {
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
		const logPath = path.join(root, sessionId, "session.jsonl");
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
				reconcileDeletedSessions,
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
			const logPath = path.join(
				await fs.realpath(logRoot),
				validSessionId(sessionId),
				"session.jsonl"
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
		appendCompaction,
		commitSessionRecord,
		createEmptySession,
		createSession,
		createSessionWithExternalizedMessage,
		createSessionUsageEntry,
		deleteSession,
		findSessionRecordBySubmissionId,
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

type SessionDeletionMarker = SessionDeletionReceipt &
	Readonly<{ logId: string }>;

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
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(markerPath, "wx", 0o600);
		await writeFully(handle, bytes, 0, markerPath, fileIo);
		await syncFile(markerPath, handle, fileIo);
		await handle.close();
		handle = undefined;
		await syncDirectory(deletedRoot);
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
		const existingHandle = await fs.open(markerPath, "r");
		try {
			await syncFile(markerPath, existingHandle, fileIo);
		} finally {
			await existingHandle.close();
		}
		await syncDirectory(deletedRoot, fileIo);
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
