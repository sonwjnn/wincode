import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionRecord, toSessionRecordId } from "@wincode/agent-core";
import { omitUndefined } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import type { EditMode } from "@/modules/tools";
import {
	type CompactionId,
	type SessionId,
	toCompactionId,
	toSessionId,
} from "@/shared/identifiers";
import { createKeyedSerialQueue } from "@/shared/utils/keyed-serial-queue";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
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
import { buildUserSessionRecord } from "./session-record";
import type {
	CommitSessionRecordInput,
	CreateEmptySessionInput,
	CreateSessionInput,
	CreateSessionUsageEntryInput,
	Session,
	SessionCatalogIssue,
	SessionCatalogResult,
	SessionStore,
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
} from "./session-writer-lock";

export type SessionLogFileIo = Readonly<{
	sync?: (filePath: string, handle: fs.FileHandle) => Promise<void>;
	write?: (
		filePath: string,
		handle: fs.FileHandle,
		bytes: Uint8Array,
		offset: number,
		length: number,
		position: number
	) => Promise<number>;
}>;

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
	type: SessionLogEventType;
}>;

type SessionCreation = Readonly<{
	createdAt: Date;
	editMode: EditMode;
	initialRecord?: SessionRecord;
	lastMessageAt: Date | null;
	model?: CreateEmptySessionInput["model"];
	pinned: boolean;
	thinkingLevel?: CreateEmptySessionInput["thinkingLevel"];
	title: string;
}>;

type SessionWrite = Readonly<{
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

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SESSION_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u;

const appendQueue = createKeyedSerialQueue();

const validSessionId = (sessionId: SessionId): string => {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
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

const syncDirectory = async (directory: string): Promise<void> => {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
};

const ensureDirectoryDurable = async (
	directory: string,
	mode = 0o700
): Promise<void> => {
	try {
		await fs.mkdir(directory, { mode });
		await syncDirectory(path.dirname(directory));
	} catch (error) {
		if (!isCode(error, "EEXIST")) {
			throw error;
		}
		const info = await fs.stat(directory);
		if (!info.isDirectory()) {
			throw new Error("Session log path is not a directory.");
		}
	}
};

const readLog = async (
	logPath: string,
	sessionId: SessionId
): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
	const bytes = await fs.readFile(logPath);
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

const isWritableSessionLogEventType = (
	type: unknown
): type is SessionLogEventType =>
	typeof type === "string" &&
	SESSION_LOG_EVENT_TYPES.includes(type as SessionLogEventType) &&
	type !== "session.header";

const sessionWriteIntentFrom = (
	value: unknown,
	sessionId: SessionId
): SessionWriteIntent => {
	const isObject =
		typeof value === "object" && value !== null && !Array.isArray(value);
	const type = isObject ? Reflect.get(value, "type") : undefined;
	const operationId = isObject ? Reflect.get(value, "operationId") : undefined;
	const storedSessionId = isObject
		? Reflect.get(value, "sessionId")
		: undefined;
	const operationDigest = isObject
		? Reflect.get(value, "operationDigest")
		: undefined;
	const expectedOffset = isObject
		? Reflect.get(value, "expectedOffset")
		: undefined;
	const sequence = isObject ? Reflect.get(value, "sequence") : undefined;
	const validSequence =
		type === "session.created" ? sequence === 1 : Number(sequence) >= 2;
	const validOffset =
		type === "session.created"
			? expectedOffset === 0
			: Number(expectedOffset) > 0;
	if (
		!isObject ||
		Reflect.get(value, "version") !== 1 ||
		!isWritableSessionLogEventType(type) ||
		!validSequence ||
		!validOffset ||
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
		type,
	};
};

const assertSameSessionWriteIntent = (
	intent: SessionWriteIntent,
	expected: Pick<
		SessionWriteIntent,
		"operationDigest" | "operationId" | "type"
	>,
	sessionId: SessionId
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
		intent.operationDigest !== expected.operationDigest
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
	intent: SessionWriteIntent,
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
	if (existing !== undefined) {
		assertSameSessionWriteIntent(existing, intent, intent.sessionId);
		return;
	}
	const temporaryPath = `${markerPath}.${randomUUIDv7()}.tmp`;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		const bytes = new TextEncoder().encode(
			`${encodeCanonicalSessionJson({ ...intent, version: 1 })}\n`
		);
		await writeFully(handle, bytes, 0, temporaryPath, fileIo);
		await syncFile(temporaryPath, handle, fileIo);
		await handle.close();
		handle = undefined;
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
			"session_log_write_not_committed",
			intent.sessionId,
			"Session write could not persist its pending marker before log mutation.",
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
	const current = await fs.readFile(logPath);
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
	await ensureDirectoryDurable(controlRoot);
	await ensureDirectoryDurable(path.dirname(quarantineRoot));
	await ensureDirectoryDurable(quarantineRoot);
	const quarantinePath = path.join(
		quarantineRoot,
		`${intent.sequence}-${intent.operationId}.partial`
	);
	const quarantineBytes = bytes.subarray(expectedOffset);
	const temporaryPath = `${quarantinePath}.${randomUUIDv7()}.tmp`;
	let quarantineHandle: fs.FileHandle | undefined;
	try {
		try {
			quarantineHandle = await fs.open(quarantinePath, "r");
			const existing = await fs.readFile(quarantinePath);
			if (!equalBytes(existing, quarantineBytes)) {
				throw new SessionLogError(
					"session_log_corrupt",
					sessionId,
					"Quarantined Session log suffix conflicts with the pending write."
				);
			}
			await syncFile(quarantinePath, quarantineHandle, fileIo);
			await syncDirectory(quarantineRoot);
		} catch (error) {
			if (!isCode(error, "ENOENT")) {
				throw error;
			}
			await quarantineHandle?.close().catch(() => undefined);
			quarantineHandle = await fs.open(temporaryPath, "wx", 0o600);
			await writeFully(
				quarantineHandle,
				quarantineBytes,
				0,
				temporaryPath,
				fileIo
			);
			await syncFile(temporaryPath, quarantineHandle, fileIo);
			await quarantineHandle.close();
			quarantineHandle = undefined;
			try {
				await fs.link(temporaryPath, quarantinePath);
			} catch (linkError) {
				if (!isCode(linkError, "EEXIST")) {
					throw linkError;
				}
				const existing = await fs.readFile(quarantinePath);
				if (!equalBytes(existing, quarantineBytes)) {
					throw new SessionLogError(
						"session_log_corrupt",
						sessionId,
						"Quarantined Session log suffix conflicts with the pending write."
					);
				}
			}
			await syncDirectory(quarantineRoot);
		}
	} finally {
		await quarantineHandle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
	}
	const current = await fs.readFile(logPath);
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
		creationDigest(previous.envelope.payload) !== creationDigest(write.payload)
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
		`${entry.envelope.operationId}.json`
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

const createLogDirectory = async (
	logRoot: string,
	sessionId: SessionId,
	creation: SessionCreation,
	fileIo: SessionLogFileIo
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
	const createdAt = creation.createdAt.toISOString();
	const payload = {
		createdAt,
		editMode: creation.editMode,
		lastMessageAt: creation.lastMessageAt?.toISOString() ?? null,
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
	const creationIntent: SessionWriteIntent = {
		expectedOffset: 0,
		operationDigest: creationDigest(operation.payload),
		operationId,
		sequence: 1,
		sessionId,
		type: "session.created",
	};
	const pendingIntent = await readSessionWriteIntent(
		logRoot,
		sessionId,
		fileIo
	);
	if (pendingIntent !== undefined) {
		assertSameSessionWriteIntent(pendingIntent, creationIntent, sessionId);
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

	try {
		const existing = await readLog(targetPath, sessionId);
		const previous = findCreationOperation(
			existing.state,
			operation,
			sessionId
		);
		if (previous !== undefined) {
			await syncAndVerifyLogPrefix(
				targetPath,
				existing.bytes,
				sessionId,
				fileIo
			);
			return await withDurableReceipt(
				false,
				previous,
				existing.state,
				pendingIntent
			);
		}
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Published Session log is missing its creation event."
		);
	} catch (error) {
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
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
	const intent = pendingIntent ?? creationIntent;
	let published = false;
	try {
		await writeSessionWriteIntent(logRoot, intent, fileIo);
		await fs.rename(staged.directory, targetDirectory);
		published = true;
		await syncDirectory(staged.root);
		await syncDirectory(canonicalRoot);
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
	state: SessionLogState
): boolean =>
	cursor !== undefined &&
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
	const compaction: SessionCompaction = {
		...input,
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

export const createSessionJsonlStore = (
	projectionStore: DrizzleSessionStore,
	logRoot: string,
	fileIo: SessionLogFileIo = {}
): SessionStore => {
	const projection = projectionStore.jsonlProjection;
	const heldWriterKeys = new Set<string>();
	const writerOperationQueue = createKeyedSerialQueue();

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
				"SQLite projection cursor does not match the committed Session log."
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
			const projectedSequence = expectedCursor?.nextSequence ?? 0;
			const pending =
				missingSession || expectedCursor === undefined
					? state.entries
					: state.entries.filter(
							({ envelope }) => envelope.sequence >= projectedSequence
						);
			try {
				projection.projectEntries(sessionId, pending, state, expectedCursor);
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
			if (projectionMatchesState(latestCursor, state)) {
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

	const ensureProjected = async (
		sessionId: SessionId
	): Promise<SessionLogState> => {
		await checkDeletedMarker(sessionId);
		if (projection.isBoundToAnotherWorkspace(sessionId)) {
			throw new Error("Session not found");
		}
		const logPath = path.join(
			await fs.realpath(logRoot),
			validSessionId(sessionId),
			"session.jsonl"
		);
		const { bytes, state } = await readLogForProjection(logPath, sessionId);
		await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo);
		await reconcileVisibleWriteIntent(sessionId, logPath, bytes, state);
		let cursor = projection.getCursor(sessionId);
		assertCursorDoesNotExceedLog(sessionId, cursor, state);
		const missingSession = await projectionSessionIsMissing(sessionId);
		if (
			missingSession ||
			cursor === undefined ||
			cursor.nextSequence < state.nextSequence
		) {
			cursor = catchUpProjection(sessionId, state, cursor, missingSession);
		}
		assertProjectionAtLogHead(sessionId, cursor, state);
		return state;
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
			if (projectionMatchesState(projection.getCursor(sessionId), state)) {
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
			const bytes = await fs.readFile(logPath);
			await quarantinePartialLogAppend(
				logRoot,
				logPath,
				sessionId,
				intent,
				bytes,
				fileIo
			);
			return;
		}
		const { bytes, state } = loaded;
		const previous = findOperation(state, write, sessionId);
		if (previous !== undefined) {
			if (
				previous.envelope.sequence !== intent.sequence ||
				previous.startOffset !== intent.expectedOffset
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
				await ensureReceipt(sessionId, previous);
				await clearSessionWriteIntent(logRoot, intent, fileIo);
			} catch (error) {
				throw new SessionWriteOutcomeError(
					toReceipt(previous, "blocked"),
					error
				);
			}
			return previous;
		}
		if (
			state.nextSequence !== intent.sequence ||
			bytes.byteLength !== intent.expectedOffset
		) {
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
		}
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
			if (pendingIntent !== undefined) {
				throw error;
			}
			let state: SessionLogState;
			try {
				({ state } = await readLog(logPath, sessionId));
			} catch {
				throw error;
			}
			const committed = await committedOperation(sessionId, write, state);
			if (committed === undefined) {
				throw error;
			}
			throw new SessionWriteOutcomeError(
				toReceipt(committed.entry, "blocked"),
				error
			);
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
		const intent: SessionWriteIntent = pendingIntent ?? {
			expectedOffset: bytes.byteLength,
			operationDigest: sessionLogOperationDigest(write.type, write.payload),
			operationId: write.operationId,
			sequence: state.nextSequence,
			sessionId,
			type: write.type,
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
			timestamp: new Date().toISOString(),
			type: write.type,
		});
		if (pendingIntent === undefined) {
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
				await assertSessionWritable(sessionId);
				const created = await createLogDirectory(
					logRoot,
					sessionId,
					initialCreation({ ...input, id: sessionId }, createdAt),
					fileIo
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

	const createSession = async (input: CreateSessionInput) => {
		const sessionId = input.id ?? toSessionId(randomUUIDv7());
		const operationId = `create-${sessionId}`;
		try {
			const createdAt = input.createdAt ?? new Date();
			const initialRecord =
				input.initialRecord ?? initialRecordFor(input, sessionId);
			const creation: SessionCreation = {
				createdAt,
				editMode: "hashline",
				initialRecord,
				lastMessageAt: createdAt,
				model: input.model,
				pinned: false,
				thinkingLevel: input.thinkingLevel,
				title: titleFor(input),
			};
			return await withTemporaryWriter(sessionId, async () => {
				await assertSessionWritable(sessionId);
				const created = await createLogDirectory(
					logRoot,
					sessionId,
					creation,
					fileIo
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

	const commitSessionRecord = async (
		input: CommitSessionRecordInput
	): Promise<SessionWriteOutcome> => {
		const operationId = `record-${input.record.id}`;
		return withWriteOutcome(input.sessionId, operationId, () =>
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
	const createSessionUsageEntry = async (
		input: CreateSessionUsageEntryInput
	): Promise<{
		entry?: SessionUsageEntry;
		writeOutcome: SessionWriteOutcome;
	}> => {
		const createdAt = input.createdAt ?? new Date();
		const operationId = `usage-${input.id}`;
		const payload = {
			createdAt: createdAt.toISOString(),
			id: input.id,
			kind: input.kind,
			model: input.model,
			usage: input.usage,
		};
		const writeOutcome = await withWriteOutcome(
			input.sessionId,
			operationId,
			() =>
				commitWrite(input.sessionId, {
					operationId,
					payload,
					type: "usage.committed",
				})
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
	const appendCompaction = async (input: AppendSessionCompactionInput) => {
		const id: CompactionId = input.id ?? toCompactionId(randomUUIDv7());
		const operationId = `compaction-${id}`;
		try {
			return await withTemporaryWriter(input.sessionId, async () => {
				await assertSessionWritable(input.sessionId);
				const state = await ensureProjected(input.sessionId);
				const { compaction, payload } = compactionForAppend(
					input,
					id,
					operationId,
					state
				);
				const writeOutcome = await commitWrite(input.sessionId, {
					operationId,
					payload,
					type: "compaction.committed",
				});
				return writeOutcome.kind === "committed"
					? { compaction, writeOutcome }
					: { writeOutcome };
			});
		} catch (error) {
			return {
				writeOutcome: sessionWriteOutcomeFromError(operationId, error),
			};
		}
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
			const writeOutcome = await commitWrite(sessionId, {
				operationId,
				payload: {},
				type: "session.deleted",
			});
			if (writeOutcome.kind !== "committed") {
				return { writeOutcome };
			}
			const { state } = await readLog(logPath, sessionId);
			return { logId: state.logId, receipt: writeOutcome };
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
	const finalizeDeletion = async (
		sessionId: SessionId,
		receipt: SessionWriteReceipt
	): Promise<SessionWriteOutcome> => {
		try {
			await ensureDirectoryDurable(logRoot);
			const root = await fs.realpath(logRoot);
			await fs.rm(path.join(root, validSessionId(sessionId)), {
				force: true,
				recursive: true,
			});
			await syncDirectory(root);
			await projectionStore.deleteSession(sessionId);
			return { ...receipt, projection: "ready" };
		} catch {
			return { ...receipt, projection: "blocked" };
		}
	};
	const deleteSession = async (
		sessionId: SessionId
	): Promise<SessionWriteOutcome> => {
		const operationId = `delete-${sessionId}`;
		let receipt: SessionWriteReceipt | undefined;
		try {
			return await withTemporaryWriter(sessionId, async () => {
				const marker = await readDeletedMarker(logRoot, sessionId);
				if (marker !== undefined) {
					receipt = { ...marker, kind: "committed", projection: "blocked" };
					return finalizeDeletion(sessionId, receipt);
				}
				await assertSessionWritable(sessionId);
				const deletion = await deletionWrite(sessionId, operationId);
				if ("writeOutcome" in deletion) {
					return deletion.writeOutcome;
				}
				receipt = {
					...deletion.receipt,
					kind: "committed",
					projection: "blocked",
				};
				await writeDeletedMarker(
					logRoot,
					sessionId,
					deletion.logId,
					deletion.receipt,
					fileIo
				);
				return finalizeDeletion(sessionId, receipt);
			});
		} catch (error) {
			return receipt === undefined
				? sessionWriteOutcomeFromError(operationId, error)
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

	const resetSessionLog = async (
		root: string,
		sessionId: SessionId
	): Promise<void> => {
		const directory = path.join(root, validSessionId(sessionId));
		const markerPath = await deletedMarkerPath(sessionId);
		try {
			await fs.access(markerPath);
			await fs.rm(directory, { force: true, recursive: true });
			await syncDirectory(root);
			return;
		} catch (error) {
			if (!isCode(error, "ENOENT")) {
				throw error;
			}
		}

		const logPath = path.join(directory, "session.jsonl");
		const state = (await readLog(logPath, sessionId)).state;
		const operationId = `delete-${validSessionId(sessionId)}`;
		const writeOutcome = await commitWrite(sessionId, {
			operationId,
			payload: {},
			type: "session.deleted",
		});
		if (writeOutcome.kind !== "committed") {
			throw new SessionWriteOutcomeError(writeOutcome);
		}
		const deletedLog = await readLog(logPath, sessionId);
		const deletion = deletedLog.state.entries.find(
			(entry) => entry.envelope.operationId === operationId
		);
		if (deletion === undefined) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				"Session deletion commit could not be verified."
			);
		}
		await writeDeletedMarker(
			logRoot,
			sessionId,
			state.logId,
			{
				entryHash: deletion.envelope.entryHash,
				operationId: deletion.envelope.operationId,
				sequence: deletion.envelope.sequence,
			},
			fileIo
		);
		await fs.rm(directory, { force: true, recursive: true });
		await syncDirectory(root);
	};

	const resetSessionData = async (): Promise<void> => {
		await assertResetAllowed();
		const sessionIds = await findSessionLogIds();
		const root = await fs.realpath(logRoot);
		const writers: SessionWriterLock[] = [];
		try {
			for (const sessionId of sessionIds) {
				writers.push(await acquireSessionWriterLock(logRoot, sessionId));
			}
			for (const sessionId of sessionIds) {
				await resetSessionLog(root, sessionId);
			}
			await projectionStore.resetSessionData();
		} finally {
			for (const writer of writers.reverse()) {
				await writer.release();
			}
		}
	};

	const wrapRead =
		<Args extends readonly unknown[], Result>(
			read: (...args: Args) => Promise<Result>
		): ((...args: Args) => Promise<Result>) =>
		async (...args) => {
			const sessionId = args[0];
			if (typeof sessionId === "string") {
				try {
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
		return { code, message, sessionId };
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

	const listSessionCatalog = async (): Promise<SessionCatalogResult> => {
		await ensureDirectoryDurable(logRoot);
		const { issues, sessionIds } = await projectExistingSessionLogs(
			await fs.realpath(logRoot)
		);
		const projected = await projectionStore.listSessions();
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
		return { issues: [...issues.values()], sessions };
	};

	const listSessions = async (): Promise<Session[]> =>
		(await listSessionCatalog()).sessions;

	projectionStore.setAttachmentCollectionBarrier(async () => {
		const catalog = await listSessionCatalog();
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
		createSessionUsageEntry,
		deleteSession,
		getCompactions: wrapRead(projectionStore.getCompactions),
		getLatestCompaction: wrapRead(projectionStore.getLatestCompaction),
		getSession: wrapRead(projectionStore.getSession),
		...(projectionStore.getEditMode === undefined
			? {}
			: { getEditMode: wrapRead(projectionStore.getEditMode) }),
		listSessionCatalog,
		listSessionRecords: wrapRead(projectionStore.listSessionRecords),
		listSessionUsageEntries: wrapRead(projectionStore.listSessionUsageEntries),
		listSessions,
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

const readDeletedMarker = async (
	logRoot: string,
	sessionId: SessionId
): Promise<SessionDeletionReceipt | undefined> => {
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
		operationId?: unknown;
		sequence?: unknown;
		sessionId?: unknown;
	};
	if (
		value.sessionId !== sessionId ||
		value.operationId !== `delete-${sessionId}` ||
		typeof value.entryHash !== "string" ||
		typeof value.sequence !== "number"
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session deletion marker is invalid."
		);
	}
	return {
		entryHash: value.entryHash,
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
		`${encodeCanonicalSessionJson({ ...receipt, logId, sessionId })}\n`
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
