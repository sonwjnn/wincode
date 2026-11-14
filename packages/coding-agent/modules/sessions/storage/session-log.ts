import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionRecord } from "@wincode/agent-core";
import { isCode, logger, omitUndefined, readUtf8File } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import { z } from "zod";
import type { EditMode } from "@/modules/tools";
import {
	isValidSessionId,
	type SessionId,
	toSessionId,
	toWorkspaceId,
	type WorkspaceId,
} from "@/shared/identifiers";
import { errorDiagnosticFields } from "@/shared/utils/error-log-fields";
import {
	createKeyedSerialQueue,
	type KeyedSerialQueue,
} from "@/shared/utils/keyed-serial-queue";
import { isValidSessionLogIdentifier } from "../session-log-identifiers";
import {
	SessionWriteOutcomeError,
	type SessionWriteReceipt,
} from "../session-write-outcome";
import { resolveSessionLogFilePath } from "./path";
import { SessionBundleImportConflictError } from "./session-bundle";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	decodeSessionLog,
	decodeSessionLogSuffix,
	encodeCanonicalSessionJson,
	encodeSessionLogLine,
	isSessionHistoryEntryEventType,
	SESSION_LOG_EVENT_TYPES,
	SESSION_LOG_HASH_PATTERN,
	type SessionHistoryEntryEventType,
	type SessionLogEntry,
	type SessionLogEnvelope,
	SessionLogError,
	type SessionLogEventType,
	type SessionLogState,
	type SessionProjectionCursor,
	sessionHistoryEntryIdForRecord,
	sessionLogOperationDigest,
} from "./session-jsonl-codec";
import type {
	CreateEmptySessionInput,
	SessionForkCheckpoint,
} from "./session-lifecycle";
import {
	ensureSessionDirectoryTreeDurably,
	publishSessionFileNoReplaceDurably,
	removeSessionFileDurably,
	replaceSessionFileDurably,
	syncDirectoryAfterDurablePathChange,
} from "./session-storage-durability";
import { withSessionCatalogLifecycleGate } from "./session-writer-lock";

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

export class SessionForkError extends Error {
	readonly code:
		| "session_busy"
		| "session_checkpoint_invalid"
		| "session_history_branches_unsupported"
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

export type SessionWriteIntent = Readonly<{
	expectedOffset: number;
	historyReferences?: Readonly<{
		activeLeafId: string;
		historyEntryId: string;
		parentEntryId: string | null;
	}>;
	operationDigest: string;
	operationId: string;
	sequence: number;
	sessionId: SessionId;
	timestamp?: string;
	type: SessionLogEventType;
	workspaceId?: WorkspaceId;
}>;

export type SessionCreation = Readonly<{
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

export type SessionWrite = Readonly<{
	envelopeTimestamp?: string;
	operationId: string;
	payload: Readonly<Record<string, unknown>>;
	type: Exclude<SessionLogEnvelope["type"], "session.header">;
}>;

export type SessionHistoryWrite = SessionWrite &
	Readonly<{ type: SessionHistoryEntryEventType }>;

export const isSessionHistoryWrite = (
	write: SessionWrite
): write is SessionHistoryWrite => isSessionHistoryEntryEventType(write.type);

export const sessionHistoryReferencesForWrite = (
	write: SessionWrite
): SessionWriteIntent["historyReferences"] => {
	if (!isSessionHistoryWrite(write)) {
		return;
	}
	return {
		activeLeafId: write.payload.activeLeafId as string,
		historyEntryId: write.payload.historyEntryId as string,
		parentEntryId: write.payload.parentEntryId as string | null,
	};
};

export type CommittedLogEntry = Readonly<{
	createdNew: boolean;
	entry: SessionLogEntry;
	receiptBlocked: boolean;
	receiptCause?: unknown;
	state: SessionLogState;
}>;

export const sessionDeletionOperationId = (sessionId: SessionId): string =>
	`delete-${validSessionId(sessionId)}`;
export const operationIdFileStem = (operationId: string): string =>
	new Bun.CryptoHasher("sha256").update(operationId).digest("hex");

type SerialQueue = KeyedSerialQueue;

// One serial queue per canonical log root: two store instances over the same
// root share it, so an in-process append from either one waits instead of
// racing into the process-owned writer lock. Queue identity is the canonical
// root, not the store instance and not the call site.
const appendQueues = new Map<string, SerialQueue>();
const forkQueues = new Map<string, SerialQueue>();
const writerQueues = new Map<string, SerialQueue>();

const serialQueueFor = async (
	logRoot: string,
	registry: Map<string, SerialQueue>
): Promise<SerialQueue> => {
	const root = await canonicalLogRoot(logRoot);
	let queue = registry.get(root);
	if (queue === undefined) {
		queue = createKeyedSerialQueue();
		registry.set(root, queue);
	}
	return queue;
};
export const validSessionId = (sessionId: SessionId): string => {
	if (!isValidSessionId(sessionId)) {
		throw new Error("Session ID is not safe for a Session log path.");
	}
	return sessionId;
};

export const canonicalLogRoot = async (logRoot: string): Promise<string> => {
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

export const sessionControlRoot = async (logRoot: string): Promise<string> =>
	path.join(path.dirname(await canonicalLogRoot(logRoot)), "session-control");

export const lockKey = async (
	logRoot: string,
	sessionId: SessionId
): Promise<string> => {
	await ensureDirectoryDurable(logRoot);
	return `${await canonicalLogRoot(logRoot)}\0${sessionId}`;
};

export const writeFully = async (
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

export const syncFile = async (
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
export const openFileForSync = (filePath: string): Promise<fs.FileHandle> =>
	fs.open(filePath, process.platform === "win32" ? "r+" : "r");

export const syncDirectory = async (
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

export const syncDirectoryAfterDurablePublication = async (
	directory: string,
	fileIo?: SessionLogFileIo
): Promise<void> =>
	await syncDirectoryAfterDurablePathChange(
		directory,
		async (path) => await syncDirectory(path, fileIo),
		fileIo?.syncDirectory !== undefined
	);

export const ensureDirectoryDurable = async (
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

export const readLog = async (
	logPath: string,
	sessionId: SessionId
): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
	const bytes = await Bun.file(logPath).bytes();
	return { bytes, state: decodeSessionLog(sessionId, bytes) };
};

export const firstDifferentByteOffset = (
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

export const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
	firstDifferentByteOffset(left, right) === undefined;

export const sessionWriteIntentPath = async (
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

export const isCanonicalTimestamp = (value: unknown): value is string => {
	if (typeof value !== "string") {
		return false;
	}
	const parsed = new Date(value);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

const sessionHistoryReferencesFrom = (
	value: unknown
): SessionWriteIntent["historyReferences"] => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return;
	}
	const activeLeafId = Reflect.get(value, "activeLeafId");
	const historyEntryId = Reflect.get(value, "historyEntryId");
	const parentEntryId = Reflect.get(value, "parentEntryId");
	if (
		typeof activeLeafId !== "string" ||
		!isValidSessionLogIdentifier(activeLeafId) ||
		typeof historyEntryId !== "string" ||
		!isValidSessionLogIdentifier(historyEntryId) ||
		(parentEntryId !== null &&
			(typeof parentEntryId !== "string" ||
				!isValidSessionLogIdentifier(parentEntryId)))
	) {
		return;
	}
	return { activeLeafId, historyEntryId, parentEntryId };
};

const sessionWriteIntentMetadataFrom = (
	value: object,
	type: unknown,
	sessionId: SessionId
): Pick<
	SessionWriteIntent,
	"historyReferences" | "timestamp" | "workspaceId"
> => {
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
	const historyReferencesRaw = Reflect.get(value, "historyReferences");
	const historyReferences = sessionHistoryReferencesFrom(historyReferencesRaw);
	const historyWrite = isSessionHistoryEntryEventType(type);
	const validVersion =
		version === 1 || version === 2 || version === 3 || version === 4;
	const validTimestamp =
		version === 1
			? timestamp === undefined || parsedTimestamp !== undefined
			: parsedTimestamp !== undefined;
	let validWorkspaceId = storedWorkspaceId === undefined;
	if (version === 3) {
		validWorkspaceId =
			type === "session.created" && parsedWorkspaceId !== undefined;
	} else if (version === 4 && type === "session.created") {
		validWorkspaceId =
			storedWorkspaceId === undefined || parsedWorkspaceId !== undefined;
	}
	let validHistoryReferences = historyReferencesRaw === undefined;
	if (version === 4 && historyWrite) {
		validHistoryReferences = historyReferences !== undefined;
	}
	if (
		!(
			validVersion &&
			validTimestamp &&
			validWorkspaceId &&
			validHistoryReferences
		)
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session has an invalid pending write marker."
		);
	}
	return omitUndefined({
		historyReferences,
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

export const assertSameSessionWriteIntent = (
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

export const readSessionWriteIntent = async (
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

export const writeSessionWriteIntent = async (
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
				version: 4,
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

export type SessionForkIntent = z.infer<typeof sessionForkIntentSchema>;

const sessionForkIntentPath = async (
	logRoot: string,
	operationId: string
): Promise<string> =>
	path.join(
		await sessionControlRoot(logRoot),
		"forks",
		`${operationIdFileStem(operationId)}.json`
	);

export const readSessionForkIntent = async (
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

export const publishCreateOnceJsonMarker = async <Value>({
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

export const writeSessionForkIntent = async (
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

export const clearSessionForkIntent = async (
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

export type SessionForkAction = z.infer<typeof sessionForkActionSchema>;

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

export const readSessionForkAction = async (
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

export const writeSessionForkAction = async (
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

export const clearSessionForkAction = async (
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

export const clearSessionWriteIntent = async (
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

export const syncAndVerifyLogSuffix = async (
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

export const syncAndVerifyLogPrefix = async (
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

export const quarantinePartialLogAppend = async (
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

export const findOperation = (
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

export const creationDigest = (
	payload: Readonly<Record<string, unknown>>
): string => {
	const {
		createdAt: _createdAt,
		lastMessageAt: _lastMessageAt,
		...semantic
	} = payload;
	return sessionLogOperationDigest("session.created", semantic);
};

export const findCreationOperation = (
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

export const ensureDurableReceipt = async (
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

export type StagedSessionLog = Readonly<{
	filePath: string;
	root: string;
}>;

export const stageSessionLog = async (
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

export const readExistingSessionLog = async (
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

const ensureSessionCreationReceipt = async ({
	createdNew,
	entry,
	fileIo,
	intent,
	logRoot,
	sessionId,
	state,
}: {
	createdNew: boolean;
	entry: SessionLogEntry;
	fileIo: SessionLogFileIo;
	intent: SessionWriteIntent | undefined;
	logRoot: string;
	sessionId: SessionId;
	state: SessionLogState;
}): Promise<CommittedLogEntry> => {
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

const prepareSessionCreationWrite = ({
	boundToWorkspace,
	creation,
	existingLog,
	operationId,
	pendingIntent,
	sessionId,
	workspaceId,
}: {
	boundToWorkspace: boolean;
	creation: SessionCreation;
	existingLog:
		| Readonly<{ bytes: Uint8Array; state: SessionLogState }>
		| undefined;
	operationId: string;
	pendingIntent: SessionWriteIntent | undefined;
	sessionId: SessionId;
	workspaceId: WorkspaceId;
}): Readonly<{
	createdAt: string;
	creationIntent: SessionWriteIntent & Readonly<{ timestamp: string }>;
	operation: SessionWrite;
}> => {
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
	const initialHistoryEntryId =
		creation.initialRecord === undefined
			? undefined
			: sessionHistoryEntryIdForRecord(sessionId, creation.initialRecord.id);
	const operation: SessionWrite = {
		operationId,
		payload: {
			activeLeafId: initialHistoryEntryId ?? null,
			createdAt,
			editMode: creation.editMode,
			lastMessageAt,
			model: creation.model,
			pinned: creation.pinned,
			thinkingLevel: creation.thinkingLevel,
			title: creation.title,
			...omitUndefined({
				initialHistoryEntryId,
				initialRecord: creation.initialRecord,
			}),
		},
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
	return { createdAt, creationIntent, operation };
};

export const createSessionLogFile = async (
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
	const { createdAt, creationIntent, operation } = prepareSessionCreationWrite({
		boundToWorkspace,
		creation,
		existingLog,
		operationId,
		pendingIntent,
		sessionId,
		workspaceId,
	});
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
			return await ensureSessionCreationReceipt({
				createdNew: false,
				entry: previous,
				fileIo,
				intent: pendingIntent,
				logRoot,
				sessionId,
				state: existingLog.state,
			});
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
		return await ensureSessionCreationReceipt({
			createdNew: true,
			entry,
			fileIo,
			intent,
			logRoot,
			sessionId,
			state,
		});
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

// Tree pages decode JSONL directly, so an append can expose a partial tail.
// The write intent brackets bytes until sync; checking both sides of the read
// lets a concurrent reader retry without acquiring writer authority.
export const readLogForHistoryTree = async (
	logRoot: string,
	fileIo: SessionLogFileIo,
	logPath: string,
	sessionId: SessionId
): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
	const changingLogError = new SessionLogError(
		"session_log_truncated",
		sessionId,
		"Session log changed while its history tree snapshot was read."
	);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		// Recheck the intent instead of trusting one observation: a writer
		// that finishes between checks leaves a complete snapshot behind, and
		// the next read must be allowed to return it.
		if (
			(await readSessionWriteIntent(logRoot, sessionId, fileIo)) !== undefined
		) {
			await Bun.sleep(10);
			continue;
		}
		try {
			const snapshot = await readLog(logPath, sessionId);
			if (
				(await readSessionWriteIntent(logRoot, sessionId, fileIo)) === undefined
			) {
				return snapshot;
			}
		} catch (error) {
			if (
				!(error instanceof SessionLogError) ||
				error.code !== "session_log_truncated"
			) {
				throw error;
			}
		}
		await Bun.sleep(10);
	}
	const intent = await readSessionWriteIntent(logRoot, sessionId, fileIo);
	if (intent === undefined) {
		throw changingLogError;
	}
	throw new SessionLogError(
		"session_log_write_indeterminate",
		sessionId,
		`Session write ${intent.operationId} has an incomplete suffix.`,
		{
			offset: intent.expectedOffset,
			operationId: intent.operationId,
			sequence: intent.sequence,
		}
	);
};

export const reconcileVisibleWriteIntent = async (
	logRoot: string,
	fileIo: SessionLogFileIo,
	sessionId: SessionId,
	logPath: string,
	bytes: Uint8Array,
	state: SessionLogState,
	workspaceId: WorkspaceId
): Promise<void> => {
	const intent = await readSessionWriteIntent(logRoot, sessionId, fileIo);
	if (intent === undefined) {
		return;
	}
	if (
		intent.type === "session.created" &&
		intent.workspaceId !== undefined &&
		intent.workspaceId !== workspaceId
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
			: sessionLogOperationDigest(entry.envelope.type, entry.envelope.payload);
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

const waitForPendingAppend = async (
	logRoot: string,
	fileIo: SessionLogFileIo,
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

export const readLogWithRetry = async (
	logRoot: string,
	fileIo: SessionLogFileIo,
	sessionId: SessionId
): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
	const logPath = resolveSessionLogFilePath(
		await canonicalLogRoot(logRoot),
		sessionId
	);
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
			await waitForPendingAppend(logRoot, fileIo, sessionId, attempt, error);
		}
	}
};

export const readLogSuffix = async (
	logRoot: string,
	fileIo: SessionLogFileIo,
	sessionId: SessionId,
	cursor: SessionProjectionCursor
): Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>> => {
	const logPath = resolveSessionLogFilePath(
		await canonicalLogRoot(logRoot),
		sessionId
	);
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
			await waitForPendingAppend(logRoot, fileIo, sessionId, attempt, error);
		}
	}
};

export type SessionImportActivationMarker = Readonly<{
	activationOperationId: string;
	bundleIdentity: string;
	cutHash: string;
	cutSequence: number;
	logId: string;
	sessionId: SessionId;
	version: 1;
	workspaceId: WorkspaceId;
}>;

export const sessionImportActivationMarkerPath = async (
	logRoot: string,
	sessionId: SessionId
): Promise<string> =>
	path.join(
		await sessionControlRoot(logRoot),
		"imports",
		`${validSessionId(sessionId)}.json`
	);

export const readSessionImportActivationMarker = async (
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

export const writeSessionImportActivationMarker = async (
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

export const removeSessionImportActivationMarker = async (
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

/**
 * The write contract for one Session log root: append primitives, write-intent
 * reconciliation, durable receipts, quarantine of an incomplete suffix, and
 * the in-process serial queues keyed by canonical root.
 *
 * The projection is deliberately absent. A caller that must refresh SQLite
 * before touching a log opens a `ProjectedSession`; this module owns only the
 * authoritative JSONL bytes.
 */
export type SessionLog = Readonly<{
	canonicalRoot: () => Promise<string>;
	controlRoot: () => Promise<string>;
	lockKey: (sessionId: SessionId) => Promise<string>;
	logPath: (sessionId: SessionId) => Promise<string>;
	read: (
		sessionId: SessionId
	) => Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>>;
	readExisting: (
		sessionId: SessionId
	) => Promise<
		Readonly<{ bytes: Uint8Array; state: SessionLogState }> | undefined
	>;
	readForHistoryTree: (
		sessionId: SessionId
	) => Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>>;
	readWithRetry: (
		sessionId: SessionId
	) => Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>>;
	readSuffix: (
		sessionId: SessionId,
		cursor: SessionProjectionCursor
	) => Promise<Readonly<{ bytes: Uint8Array; state: SessionLogState }>>;
	writeIntentPath: (sessionId: SessionId) => Promise<string>;
	ensureRootDurable: () => Promise<void>;
	reconcileVisibleWriteIntent: (
		sessionId: SessionId,
		logPath: string,
		bytes: Uint8Array,
		state: SessionLogState,
		workspaceId: WorkspaceId
	) => Promise<void>;
	readWriteIntent: (
		sessionId: SessionId
	) => Promise<SessionWriteIntent | undefined>;
	writeIntent: (
		intent: SessionWriteIntent & Readonly<{ timestamp: string }>
	) => Promise<void>;
	clearWriteIntent: (intent: SessionWriteIntent) => Promise<void>;
	readForkIntent: (
		operationId: string,
		sourceSessionId: SessionId
	) => Promise<SessionForkIntent | undefined>;
	writeForkIntent: (
		intent: SessionForkIntent,
		sourceSessionId: SessionId
	) => Promise<SessionForkIntent>;
	clearForkIntent: (
		intent: SessionForkIntent,
		sourceSessionId: SessionId
	) => Promise<void>;
	readForkAction: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint
	) => Promise<SessionForkAction | undefined>;
	writeForkAction: (
		action: SessionForkAction,
		checkpoint: SessionForkCheckpoint
	) => Promise<SessionForkAction>;
	clearForkAction: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<void>;
	readDeletedMarker: (
		sessionId: SessionId
	) => Promise<SessionDeletionMarker | undefined>;
	writeDeletedMarker: (
		sessionId: SessionId,
		logId: string,
		receipt: SessionDeletionReceipt
	) => Promise<void>;
	syncPrefix: (
		logPath: string,
		bytes: Uint8Array,
		sessionId: SessionId,
		sequence?: number
	) => Promise<void>;
	syncSuffix: (
		logPath: string,
		startOffset: number,
		bytes: Uint8Array,
		sessionId: SessionId
	) => Promise<void>;
	ensureReceipt: (
		sessionId: SessionId,
		entry: SessionLogEntry
	) => Promise<void>;
	appendBytes: (
		sessionId: SessionId,
		logPath: string,
		entryBytes: Uint8Array,
		intent: SessionWriteIntent
	) => Promise<void>;
	verifyAppended: (
		sessionId: SessionId,
		logPath: string,
		envelope: SessionLogEnvelope,
		intent: SessionWriteIntent
	) => Promise<Readonly<{ entry: SessionLogEntry; state: SessionLogState }>>;
	quarantinePendingAppend: (
		sessionId: SessionId,
		logPath: string,
		intent: SessionWriteIntent
	) => Promise<void>;
	stage: (
		canonicalRoot: string,
		sessionId: SessionId,
		operationId: string,
		bytes: Uint8Array
	) => Promise<StagedSessionLog>;
	publishStaged: (
		staged: StagedSessionLog,
		targetPath: string,
		onPublished?: () => void
	) => Promise<void>;
	removeLog: (sessionId: SessionId) => Promise<void>;
	createLog: (
		sessionId: SessionId,
		creation: SessionCreation,
		workspaceId: WorkspaceId,
		isBoundToWorkspace: () => boolean,
		isBoundToAnotherWorkspace: () => boolean,
		bindSessionToWorkspace: () => void
	) => Promise<CommittedLogEntry>;
	quarantinePartialAppend: (
		logPath: string,
		sessionId: SessionId,
		intent: SessionWriteIntent,
		bytes: Uint8Array
	) => Promise<void>;
	ensureDirectory: (directory: string, mode?: number) => Promise<void>;
	runSerial: <Result>(
		sessionId: SessionId,
		operation: () => Promise<Result>
	) => Promise<Result>;
	runWriter: <Result>(
		sessionId: SessionId,
		operation: () => Promise<Result>
	) => Promise<Result>;
	withAppendQueue: <Result>(
		sessionIds: readonly SessionId[],
		operation: () => Promise<Result>
	) => Promise<Result>;
	withForkQueue: <Result>(
		sourceSessionId: SessionId,
		operationId: string,
		operation: () => Promise<Result>
	) => Promise<Result>;
}>;

export const sessionLogFor = (
	logRoot: string,
	fileIo: SessionLogFileIo = {}
): SessionLog => {
	const runSerial = async <Result>(
		sessionId: SessionId,
		operation: () => Promise<Result>
	): Promise<Result> => {
		const queue = await serialQueueFor(logRoot, appendQueues);
		return await queue.run(validSessionId(sessionId), operation);
	};

	const appendBytes = async (
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

	const verifyAppended = async (
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

	const quarantinePendingAppend = async (
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

	const publishStaged = async (
		staged: StagedSessionLog,
		targetPath: string,
		onPublished?: () => void
	): Promise<void> => {
		await publishSessionFileNoReplaceDurably(
			staged.filePath,
			targetPath,
			async (directory) => await syncDirectory(directory, fileIo),
			fileIo.syncDirectory !== undefined,
			onPublished
		);
		await syncDirectoryAfterDurablePublication(staged.root, fileIo);
	};

	const removeLog = async (sessionId: SessionId): Promise<void> => {
		const root = await canonicalLogRoot(logRoot);
		const logPath = resolveSessionLogFilePath(root, sessionId);
		const removeFile = fileIo.remove;
		await removeSessionFileDurably(
			logPath,
			root,
			async (directory) => await syncDirectory(directory, fileIo),
			removeFile === undefined
				? undefined
				: async (filePath) => await removeFile(filePath, { force: true })
		);
	};

	return {
		canonicalRoot: async () => await canonicalLogRoot(logRoot),
		controlRoot: async () => await sessionControlRoot(logRoot),
		lockKey: async (sessionId) => await lockKey(logRoot, sessionId),
		logPath: async (sessionId) =>
			resolveSessionLogFilePath(await canonicalLogRoot(logRoot), sessionId),
		read: async (sessionId) =>
			await readLog(
				resolveSessionLogFilePath(await canonicalLogRoot(logRoot), sessionId),
				sessionId
			),
		readExisting: async (sessionId) =>
			await readExistingSessionLog(
				resolveSessionLogFilePath(await canonicalLogRoot(logRoot), sessionId),
				sessionId
			),
		readForHistoryTree: async (sessionId) =>
			await readLogForHistoryTree(
				logRoot,
				fileIo,
				resolveSessionLogFilePath(await canonicalLogRoot(logRoot), sessionId),
				sessionId
			),
		readWithRetry: async (sessionId) =>
			await readLogWithRetry(logRoot, fileIo, sessionId),
		readSuffix: async (sessionId, cursor) =>
			await readLogSuffix(logRoot, fileIo, sessionId, cursor),
		writeIntentPath: async (sessionId) =>
			await sessionWriteIntentPath(logRoot, sessionId),
		ensureRootDurable: async () => await ensureDirectoryDurable(logRoot),
		reconcileVisibleWriteIntent: async (
			sessionId,
			logPath,
			bytes,
			state,
			workspaceId
		) =>
			await reconcileVisibleWriteIntent(
				logRoot,
				fileIo,
				sessionId,
				logPath,
				bytes,
				state,
				workspaceId
			),
		readWriteIntent: async (sessionId) =>
			await readSessionWriteIntent(logRoot, sessionId, fileIo),
		writeIntent: async (intent) =>
			await writeSessionWriteIntent(logRoot, intent, fileIo),
		clearWriteIntent: async (intent) =>
			await clearSessionWriteIntent(logRoot, intent, fileIo),
		readForkIntent: async (operationId, sourceSessionId) =>
			await readSessionForkIntent(logRoot, operationId, sourceSessionId),
		writeForkIntent: async (intent, sourceSessionId) =>
			await writeSessionForkIntent(logRoot, intent, sourceSessionId, fileIo),
		clearForkIntent: async (intent, sourceSessionId) =>
			await clearSessionForkIntent(logRoot, intent, sourceSessionId, fileIo),
		readForkAction: async (sourceSessionId, checkpoint) =>
			await readSessionForkAction(logRoot, sourceSessionId, checkpoint),
		writeForkAction: async (action, checkpoint) =>
			await writeSessionForkAction(logRoot, action, checkpoint, fileIo),
		clearForkAction: async (sourceSessionId, checkpoint, operationId) =>
			await clearSessionForkAction(
				logRoot,
				sourceSessionId,
				checkpoint,
				operationId,
				fileIo
			),
		readDeletedMarker: async (sessionId) =>
			await readDeletedMarker(logRoot, sessionId),
		writeDeletedMarker: async (sessionId, logId, receipt) =>
			await writeDeletedMarker(logRoot, sessionId, logId, receipt, fileIo),
		syncPrefix: async (logPath, bytes, sessionId, sequence) =>
			await syncAndVerifyLogPrefix(logPath, bytes, sessionId, fileIo, sequence),
		syncSuffix: async (logPath, startOffset, bytes, sessionId) =>
			await syncAndVerifyLogSuffix(
				logPath,
				startOffset,
				bytes,
				sessionId,
				fileIo
			),
		ensureReceipt: async (sessionId, entry) =>
			await ensureDurableReceipt(logRoot, sessionId, entry, fileIo),
		appendBytes,
		verifyAppended,
		quarantinePendingAppend,
		stage: async (canonicalRoot, sessionId, operationId, bytes) =>
			await stageSessionLog(
				canonicalRoot,
				sessionId,
				operationId,
				bytes,
				fileIo
			),
		publishStaged,
		removeLog,
		createLog: async (
			sessionId,
			creation,
			workspaceId,
			isBoundToWorkspace,
			isBoundToAnotherWorkspace,
			bindSessionToWorkspace
		) =>
			await createSessionLogFile(
				logRoot,
				sessionId,
				creation,
				fileIo,
				workspaceId,
				isBoundToWorkspace,
				isBoundToAnotherWorkspace,
				bindSessionToWorkspace
			),
		quarantinePartialAppend: async (logPath, sessionId, intent, bytes) =>
			await quarantinePartialLogAppend(
				logRoot,
				logPath,
				sessionId,
				intent,
				bytes,
				fileIo
			),
		ensureDirectory: async (directory, mode) =>
			await ensureDirectoryDurable(directory, mode, fileIo),
		runSerial,
		runWriter: async (sessionId, operation) => {
			const queue = await serialQueueFor(logRoot, writerQueues);
			return await queue.run(validSessionId(sessionId), operation);
		},
		withAppendQueue: async <Result>(
			sessionIds: readonly SessionId[],
			operation: () => Promise<Result>
		): Promise<Result> => {
			const queue = await serialQueueFor(logRoot, appendQueues);
			const keys = [...new Set(sessionIds)].sort().map(validSessionId);
			const acquire = async (index: number): Promise<Result> => {
				const key = keys[index];
				if (key === undefined) {
					return await operation();
				}
				return await queue.run(key, async () => await acquire(index + 1));
			};
			return await acquire(0);
		},
		withForkQueue: async (sourceSessionId, operationId, operation) => {
			const queue = await serialQueueFor(logRoot, forkQueues);
			return await queue.run(
				`${validSessionId(sourceSessionId)}\0fork\0${operationId}`,
				operation
			);
		},
	};
};
export const toReceipt = (
	entry: SessionLogEntry,
	projection: SessionWriteReceipt["projection"]
): SessionWriteReceipt => ({
	entryHash: entry.envelope.entryHash,
	kind: "committed",
	operationId: entry.envelope.operationId,
	projection,
	sequence: entry.envelope.sequence,
});

export type SessionDeletionReceipt = Readonly<{
	entryHash: string;
	operationId: string;
	sequence: number;
}>;

export function deletionReceiptFromEntry(
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

export type SessionDeletionMarker = SessionDeletionReceipt &
	Readonly<{ logId: string }>;

export const readDeletedMarker = async (
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

export const writeDeletedMarker = async (
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

export const indeterminateLogWriteError = (
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
