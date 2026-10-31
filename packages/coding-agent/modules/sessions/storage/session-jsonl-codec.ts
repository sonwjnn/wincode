import type { SessionRecord } from "@wincode/agent-core";
import { modelUsageSchema, thinkingLevelSchema } from "@wincode/ai";
import { z } from "zod";
import { providerModelSelectionSchema } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceSchema } from "@/modules/sessions/attachment-reference";
import { editModeSchema } from "@/modules/tools/versioned/contracts";
import type { SessionId } from "@/shared/identifiers";
import { getSessionRecordValidationError } from "./session-record";

export const SESSION_LOG_FORMAT_VERSION = 1;
export const SESSION_LOG_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export const SESSION_LOG_EVENT_TYPES = [
	"session.header",
	"session.created",
	"session.metadata-updated",
	"record.committed",
	"submission.status-updated",
	"compaction.committed",
	"usage.committed",
	"session.activation-confirmed",
	"session.deleted",
] as const;

export type SessionLogEventType = (typeof SESSION_LOG_EVENT_TYPES)[number];

export type SessionLogEnvelope = Readonly<{
	entryHash: string;
	formatVersion: number;
	operationId: string;
	payload: Readonly<Record<string, unknown>>;
	previousHash: string | null;
	sequence: number;
	sessionId: SessionId;
	timestamp: string;
	type: SessionLogEventType;
}>;

export type SessionLogEntry = Readonly<{
	envelope: SessionLogEnvelope;
	endOffset: number;
	startOffset: number;
}>;

export type SessionLogState = Readonly<{
	entries: readonly SessionLogEntry[];
	logId: string;
	nextOffset: number;
	nextSequence: number;
	lastHash: string;
}>;

export type SessionProjectionCursor = Readonly<{
	lastHash: string;
	logId: string;
	nextByteOffset: number;
	nextSequence: number;
}>;

export const sessionProjectionCursorsEqual = (
	left: SessionProjectionCursor | undefined,
	right: SessionProjectionCursor | undefined
): boolean =>
	left === undefined
		? right === undefined
		: right !== undefined &&
			left.logId === right.logId &&
			left.nextSequence === right.nextSequence &&
			left.nextByteOffset === right.nextByteOffset &&
			left.lastHash === right.lastHash;

export type SessionJsonlProjection = Readonly<{
	getCursor: (sessionId: SessionId) => SessionProjectionCursor | undefined;
	isBoundToAnotherWorkspace: (sessionId: SessionId) => boolean;
	projectEntries: (
		sessionId: SessionId,
		entries: readonly SessionLogEntry[],
		state: SessionLogState,
		expectedCursor: SessionProjectionCursor | undefined
	) => void;
}>;

export class SessionLogError extends Error {
	readonly code:
		| "session_log_corrupt"
		| "session_log_truncated"
		| "session_log_version_unsupported"
		| "session_log_write_indeterminate"
		| "session_log_write_not_committed"
		| "session_operation_conflict"
		| "session_projection_blocked"
		| "session_deleted";
	readonly offset: number | undefined;
	readonly operationId: string | undefined;
	readonly sequence: number | undefined;
	readonly sessionId: SessionId;

	constructor(
		code: SessionLogError["code"],
		sessionId: SessionId,
		message: string,
		details: Readonly<{
			cause?: unknown;
			offset?: number;
			operationId?: string;
			sequence?: number;
		}> = {}
	) {
		super(message);
		this.name = "SessionLogError";
		this.code = code;
		this.sessionId = sessionId;
		this.offset = details.offset;
		this.operationId = details.operationId;
		this.sequence = details.sequence;
		if ("cause" in details) {
			this.cause = details.cause;
		}
	}
}

const safeIdentifierSchema = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const envelopeSchema = z
	.object({
		entryHash: z.string().regex(SESSION_LOG_HASH_PATTERN),
		formatVersion: z.number().int(),
		operationId: safeIdentifierSchema,
		payload: z.record(z.string(), z.unknown()),
		previousHash: z.string().regex(SESSION_LOG_HASH_PATTERN).nullable(),
		sequence: z.number().int().nonnegative(),
		sessionId: safeIdentifierSchema,
		timestamp: z.string().datetime(),
		type: z.enum(SESSION_LOG_EVENT_TYPES),
	})
	.strict();

const createdPayloadSchema = z
	.object({
		createdAt: z.string().datetime(),
		editMode: editModeSchema,
		initialRecord: z.unknown().optional(),
		lastMessageAt: z.string().datetime().nullable(),
		model: providerModelSelectionSchema.optional(),
		pinned: z.boolean(),
		thinkingLevel: thinkingLevelSchema.optional(),
		title: z.string(),
	})
	.strict();

const metadataUpdatedPayloadSchema = z
	.object({
		editMode: editModeSchema.optional(),
		model: providerModelSelectionSchema.optional(),
		pinned: z.boolean().optional(),
		thinkingLevel: thinkingLevelSchema.optional(),
		title: z.string().optional(),
	})
	.strict()
	.refine((payload) => Object.keys(payload).length > 0);

const recordCommittedPayloadSchema = z
	.object({
		record: z.unknown(),
		sessionModel: providerModelSelectionSchema.optional(),
		sessionThinkingLevel: thinkingLevelSchema.optional(),
	})
	.strict();

const submissionStatusPayloadSchema = z
	.object({
		failure: z.string().optional(),
		messageId: safeIdentifierSchema,
		recordId: safeIdentifierSchema,
		status: z.enum(["failed", "pending", "processed", "processing"]),
		submissionId: safeIdentifierSchema,
	})
	.strict();

const compactionSummarySchema = z
	.object({
		attachments: z
			.array(
				attachmentReferenceSchema.extend({
					available: z.boolean(),
					payloadOmitted: z.literal(true),
				})
			)
			.optional(),
		coveredMessageIds: z.array(safeIdentifierSchema),
		fileOperations: z
			.object({ modified: z.array(z.string()), read: z.array(z.string()) })
			.strict()
			.optional(),
		formatVersion: z.literal(1),
		focus: z.string().optional(),
		text: z.string(),
	})
	.strict();

const compactionPayloadSchema = z
	.object({
		completedAt: z.string().datetime(),
		createdAt: z.string().datetime(),
		estimatedTokensAfter: z.number().int().nonnegative(),
		firstKeptAssistantPartIndex: z.number().int().nonnegative().nullable(),
		firstKeptUiMessageId: safeIdentifierSchema,
		focus: z.string().nullable(),
		id: safeIdentifierSchema,
		priorCompactionId: safeIdentifierSchema.nullable(),
		sequence: z.number().int().positive(),
		summarizationModel: providerModelSelectionSchema,
		summarizationThinkingLevel: thinkingLevelSchema.nullable(),
		summarizationUsage: modelUsageSchema.nullable(),
		summary: compactionSummarySchema,
		tokensBefore: z.number().int().nonnegative(),
		trigger: z.enum(["manual", "threshold", "overflow"]),
		throughMessageUiId: safeIdentifierSchema,
	})
	.strict();

const usageCommittedPayloadSchema = z
	.object({
		createdAt: z.string().datetime(),
		id: safeIdentifierSchema,
		kind: z.enum(["cache-warm", "compaction-summary"]),
		model: providerModelSelectionSchema,
		usage: modelUsageSchema,
	})
	.strict();

const eventPayloadSchemas: Readonly<
	Record<Exclude<SessionLogEventType, "session.header">, z.ZodType>
> = {
	"session.created": createdPayloadSchema,
	"session.metadata-updated": metadataUpdatedPayloadSchema,
	"record.committed": recordCommittedPayloadSchema,
	"submission.status-updated": submissionStatusPayloadSchema,
	"compaction.committed": compactionPayloadSchema,
	"usage.committed": usageCommittedPayloadSchema,
	"session.activation-confirmed": z.object({}).strict(),
	"session.deleted": z.object({}).strict(),
};

const compareCanonicalKeys = (left: string, right: string): number => {
	if (left < right) {
		return -1;
	}
	return left > right ? 1 : 0;
};

const recordFromEventPayload = (
	type: SessionLogEventType,
	payload: Readonly<Record<string, unknown>>
): unknown => {
	if (type === "record.committed") {
		return payload.record;
	}
	if (type === "session.created") {
		return payload.initialRecord;
	}
};

const canonicalValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(canonicalValue);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error("Session JSONL values must use plain JSON objects.");
	}
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => compareCanonicalKeys(left, right))
			.map(([key, item]) => [key, canonicalValue(item)])
	);
};

export const encodeCanonicalSessionJson = (value: unknown): string => {
	const encoded = JSON.stringify(canonicalValue(value));
	if (encoded === undefined) {
		throw new Error("Session JSONL values must be JSON serializable.");
	}
	return encoded;
};

const sha256 = (value: string | Uint8Array): string =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");

const semanticOperationDigest = (
	type: SessionLogEventType,
	payload: Readonly<Record<string, unknown>>
): string => sha256(encodeCanonicalSessionJson({ payload, type }));

const createEnvelope = ({
	operationId,
	payload,
	previousHash,
	sequence,
	sessionId,
	timestamp,
	type,
}: Omit<
	SessionLogEnvelope,
	"entryHash" | "formatVersion"
>): SessionLogEnvelope => {
	if (
		!(
			safeIdentifierSchema.safeParse(operationId).success &&
			safeIdentifierSchema.safeParse(sessionId).success
		)
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log identity is not a safe identifier.",
			{ sequence }
		);
	}
	const unsigned = {
		formatVersion: SESSION_LOG_FORMAT_VERSION,
		operationId,
		payload,
		previousHash,
		sequence,
		sessionId,
		timestamp,
		type,
	};
	return {
		...unsigned,
		entryHash: sha256(encodeCanonicalSessionJson(unsigned)),
	};
};

export const encodeSessionLogLine = (
	envelope: SessionLogEnvelope
): Uint8Array =>
	new TextEncoder().encode(`${encodeCanonicalSessionJson(envelope)}\n`);

export const createSessionLogHeader = (
	sessionId: SessionId,
	logId: string,
	timestamp: string
): SessionLogEnvelope =>
	createEnvelope({
		operationId: `header-${sessionId}`,
		payload: { logId },
		previousHash: null,
		sequence: 0,
		sessionId,
		timestamp,
		type: "session.header",
	});

export const createSessionLogEvent = ({
	operationId,
	payload,
	previousHash,
	sequence,
	sessionId,
	timestamp,
	type,
}: Omit<
	SessionLogEnvelope,
	"entryHash" | "formatVersion"
>): SessionLogEnvelope => {
	if (type === "session.header") {
		throw new Error("Session log headers are created only at sequence zero.");
	}
	const parsed = eventPayloadSchemas[type].safeParse(payload);
	if (!parsed.success) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			`Invalid ${type} payload: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`,
			{ sequence }
		);
	}
	const parsedPayload = parsed.data as Readonly<Record<string, unknown>>;
	const record = recordFromEventPayload(type, parsedPayload);
	if (record !== undefined) {
		const validationError = getSessionRecordValidationError(record);
		if (validationError !== null) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				`Invalid committed Session Record: ${validationError}.`,
				{ sequence }
			);
		}
	}
	return createEnvelope({
		operationId,
		payload: parsedPayload,
		previousHash,
		sequence,
		sessionId,
		timestamp,
		type,
	});
};

const parseUtf8JsonLine = (
	bytes: Uint8Array,
	sessionId: SessionId,
	offset: number
): unknown => {
	if (
		offset === 0 &&
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log must not begin with a UTF-8 BOM.",
			{ offset }
		);
	}
	if (bytes.at(-1) === 0x0d) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log framing requires LF without a preceding CR.",
			{ offset }
		);
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains an invalid complete UTF-8 JSON line.",
			{ offset }
		);
	}
};

const parseEnvelopeLine = (
	parsedJson: unknown,
	sessionId: SessionId,
	offset: number
): SessionLogEnvelope => {
	if (
		typeof parsedJson === "object" &&
		parsedJson !== null &&
		Reflect.get(parsedJson, "formatVersion") !== SESSION_LOG_FORMAT_VERSION
	) {
		throw new SessionLogError(
			"session_log_version_unsupported",
			sessionId,
			"Session log format version is not supported.",
			{ offset }
		);
	}
	const parsedEnvelope = envelopeSchema.safeParse(parsedJson);
	if (!parsedEnvelope.success) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains an invalid envelope.",
			{ offset }
		);
	}
	const envelope = parsedEnvelope.data as SessionLogEnvelope;
	if (envelope.sessionId !== sessionId) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log entry belongs to another Session.",
			{ offset, sequence: envelope.sequence }
		);
	}
	const { entryHash, ...unsigned } = envelope;
	if (sha256(encodeCanonicalSessionJson(unsigned)) !== entryHash) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log entry hash does not match its envelope.",
			{ offset, sequence: envelope.sequence }
		);
	}
	return envelope;
};

const validateEventLine = (
	envelope: SessionLogEnvelope,
	sessionId: SessionId,
	offset: number
): void => {
	if (envelope.type === "session.header") {
		return;
	}
	const payload = eventPayloadSchemas[envelope.type].safeParse(
		envelope.payload
	);
	if (!payload.success) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			`Invalid ${envelope.type} payload.`,
			{ offset, sequence: envelope.sequence }
		);
	}
	const record = recordFromEventPayload(
		envelope.type,
		payload.data as Readonly<Record<string, unknown>>
	);
	if (record === undefined) {
		return;
	}
	const validationError = getSessionRecordValidationError(record);
	if (validationError !== null) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			`Invalid committed Session Record: ${validationError}.`,
			{ offset, sequence: envelope.sequence }
		);
	}
};

const parseLine = (
	bytes: Uint8Array,
	sessionId: SessionId,
	offset: number
): SessionLogEnvelope => {
	const parsedJson = parseUtf8JsonLine(bytes, sessionId, offset);
	const envelope = parseEnvelopeLine(parsedJson, sessionId, offset);
	validateEventLine(envelope, sessionId, offset);
	return envelope;
};

const nextLineEnd = (
	bytes: Uint8Array,
	sessionId: SessionId,
	offset: number
): number => {
	let lineEnd = offset;
	while (lineEnd < bytes.byteLength && bytes[lineEnd] !== 0x0a) {
		lineEnd += 1;
	}
	if (lineEnd === bytes.byteLength) {
		throw new SessionLogError(
			"session_log_truncated",
			sessionId,
			"Session log ends with an uncommitted line without LF framing.",
			{ offset }
		);
	}
	if (lineEnd === offset) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains an empty complete line.",
			{ offset }
		);
	}
	return lineEnd;
};

const assertSequenceAndPredecessor = (
	envelope: SessionLogEnvelope,
	expectedSequence: number,
	previousHash: string | null,
	sessionId: SessionId,
	offset: number
): void => {
	if (
		envelope.sequence !== expectedSequence ||
		envelope.previousHash !== previousHash ||
		(expectedSequence === 0 && envelope.type !== "session.header") ||
		(expectedSequence > 0 && envelope.type === "session.header")
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log sequence or hash-chain predecessor is invalid.",
			{ offset, sequence: envelope.sequence }
		);
	}
};

const registerUniqueOperation = (
	envelope: SessionLogEnvelope,
	operationDigests: Map<string, string>,
	sessionId: SessionId,
	offset: number
): void => {
	const digest = semanticOperationDigest(envelope.type, envelope.payload);
	const previousOperation = operationDigests.get(envelope.operationId);
	if (previousOperation !== undefined) {
		const message =
			previousOperation === digest
				? "Session log repeats a committed operation identity."
				: "Session log reuses an operation identity with different payload.";
		throw new SessionLogError("session_log_corrupt", sessionId, message, {
			offset,
			sequence: envelope.sequence,
		});
	}
	operationDigests.set(envelope.operationId, digest);
};

const getHeaderLogId = (
	envelope: SessionLogEnvelope,
	sessionId: SessionId,
	offset: number
): string => {
	const headerPayload = z
		.object({ logId: safeIdentifierSchema })
		.strict()
		.safeParse(envelope.payload);
	if (!headerPayload.success || envelope.previousHash !== null) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log header is invalid.",
			{ offset, sequence: 0 }
		);
	}
	return headerPayload.data.logId;
};

export const decodeSessionLog = (
	sessionId: SessionId,
	bytes: Uint8Array
): SessionLogState => {
	const entries: SessionLogEntry[] = [];
	const operationDigests = new Map<string, string>();
	let offset = 0;
	let expectedSequence = 0;
	let previousHash: string | null = null;
	let logId: string | undefined;
	let deleted = false;
	while (offset < bytes.byteLength) {
		const lineEnd = nextLineEnd(bytes, sessionId, offset);
		const envelope = parseLine(
			bytes.subarray(offset, lineEnd),
			sessionId,
			offset
		);
		assertSequenceAndPredecessor(
			envelope,
			expectedSequence,
			previousHash,
			sessionId,
			offset
		);
		if (
			(expectedSequence === 1 && envelope.type !== "session.created") ||
			(expectedSequence > 1 && envelope.type === "session.created") ||
			deleted
		) {
			throw new SessionLogError(
				"session_log_corrupt",
				sessionId,
				deleted
					? "Session log contains an entry after its deletion checkpoint."
					: "Session log must begin with exactly one creation checkpoint.",
				{ offset, sequence: envelope.sequence }
			);
		}
		if (envelope.type === "session.deleted") {
			deleted = true;
		}
		registerUniqueOperation(envelope, operationDigests, sessionId, offset);
		if (expectedSequence === 0) {
			logId = getHeaderLogId(envelope, sessionId, offset);
		}
		const endOffset = lineEnd + 1;
		entries.push({ envelope, endOffset, startOffset: offset });
		offset = endOffset;
		expectedSequence += 1;
		previousHash = envelope.entryHash;
	}
	if (entries.length < 2 || logId === undefined || previousHash === null) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log is missing its header.",
			{ offset: 0 }
		);
	}
	return {
		entries,
		lastHash: previousHash,
		logId,
		nextOffset: bytes.byteLength,
		nextSequence: expectedSequence,
	};
};

export const sessionLogOperationDigest = semanticOperationDigest;

export const isSessionRecord = (value: unknown): value is SessionRecord =>
	getSessionRecordValidationError(value) === null;
