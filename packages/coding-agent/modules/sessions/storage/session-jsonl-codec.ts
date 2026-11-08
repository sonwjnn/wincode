import {
	isSessionToolCallPart,
	type SessionMessageId,
	type SessionRecord,
	type SessionSubmissionStatus,
} from "@wincode/agent-core";
import { modelUsageSchema, thinkingLevelSchema } from "@wincode/ai";
import { stableStringifyJson } from "@wincode/utils";
import { z } from "zod";
import { providerModelSelectionSchema } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceSchema } from "@/modules/sessions/attachment-reference";
import type { SessionCompaction } from "@/modules/sessions/compaction/types";
import { assertCompactionMessageReferences } from "@/modules/sessions/compaction/validation";
import { sessionContextEditSchema } from "@/modules/sessions/context-edits";
import { SESSION_LOG_IDENTIFIER_PATTERN } from "@/modules/sessions/session-log-identifiers";
import { editModeSchema } from "@/modules/tools/versioned/contracts";
import type {
	CompactionId,
	SessionId,
	WorkspaceId,
} from "@/shared/identifiers";
import { getSessionRecordValidationError } from "./session-record";

export const SESSION_LOG_FORMAT_VERSION = 1;
export const SESSION_LOG_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export const SESSION_LOG_EVENT_TYPES = [
	"session.header",
	"session.created",
	"session.metadata-updated",
	"record.committed",
	"context.edited",
	"submission.status-updated",
	"compaction.committed",
	"usage.committed",
	"session.activation-confirmed",
	"session.forked",
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
	generation: number;
	lastHash: string;
	logId: string;
	nextByteOffset: number;
	nextSequence: number;
}>;

export type SessionProjectionMaintenanceState = Readonly<{
	catalogRevision: number;
	generation: number;
	projectionId: string;
	latestDeletionRevision: number;
	paginationVersion: number;
	status: "ready" | "rebuilding";
}>;

export const sessionProjectionCursorsEqual = (
	left: SessionProjectionCursor | undefined,
	right: SessionProjectionCursor | undefined
): boolean =>
	left === undefined
		? right === undefined
		: right !== undefined &&
			left.generation === right.generation &&
			left.logId === right.logId &&
			left.nextSequence === right.nextSequence &&
			left.nextByteOffset === right.nextByteOffset &&
			left.lastHash === right.lastHash;

export type SessionJsonlProjection = Readonly<{
	beginRebuild: () => number;
	workspaceId: WorkspaceId;
	bindSessionToWorkspace: (sessionId: SessionId) => void;
	completeRebuild: (
		generation: number,
		completesStatisticsRebuild: boolean
	) => void;
	getCursor: (sessionId: SessionId) => SessionProjectionCursor | undefined;
	isSessionImportActivationConfirmed: (sessionId: SessionId) => boolean;
	getMaintenanceState: () => SessionProjectionMaintenanceState;
	isBoundToAnotherWorkspace: (sessionId: SessionId) => boolean;
	isBoundToWorkspace: (sessionId: SessionId) => boolean;
	listAllBoundSessionIds: () => SessionId[];
	listBoundSessionIds: () => SessionId[];
	listSessionIds: () => SessionId[];
	withReadyGenerationRead: <Result>(
		sessionIds: readonly SessionId[],
		operation: (maintenance: SessionProjectionMaintenanceState) => Result
	) => Result;
	projectEntries: (
		sessionId: SessionId,
		entries: readonly SessionLogEntry[],
		state: SessionLogState,
		expectedCursor: SessionProjectionCursor | undefined,
		mode?: "append" | "replace" | "maintenance"
	) => void;
}>;

export class SessionLogError extends Error {
	readonly code:
		| "session_log_corrupt"
		| "session_log_truncated"
		| "session_log_version_unsupported"
		| "session_log_write_indeterminate"
		| "session_log_write_not_committed"
		| "session_not_found"
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
	.regex(SESSION_LOG_IDENTIFIER_PATTERN);

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

export type SessionSubmissionStatusPayload = z.infer<
	typeof submissionStatusPayloadSchema
>;

export const parseSessionSubmissionStatusPayload = (
	value: unknown
): SessionSubmissionStatusPayload => submissionStatusPayloadSchema.parse(value);

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
		overflowSourceTurnId: safeIdentifierSchema.optional(),
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

export type SessionCompactionPayload = z.infer<typeof compactionPayloadSchema>;

export const parseSessionCompactionPayload = (
	value: unknown
): SessionCompactionPayload => compactionPayloadSchema.parse(value);

const inheritedUsageIdentitySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("record"),
			recordId: safeIdentifierSchema,
			sessionId: safeIdentifierSchema,
		})
		.strict(),
	z
		.object({
			entryId: safeIdentifierSchema,
			kind: z.literal("usage-entry"),
			sessionId: safeIdentifierSchema,
		})
		.strict(),
	z
		.object({
			compactionId: safeIdentifierSchema,
			kind: z.literal("compaction"),
			sessionId: safeIdentifierSchema,
		})
		.strict(),
]);

const inheritedUsageContributionSchema = z
	.object({
		cost: z
			.object({ amount: z.number().finite().nonnegative(), unit: z.string() })
			.strict()
			.nullable(),
		identity: inheritedUsageIdentitySchema,
		model: providerModelSelectionSchema,
		turnId: safeIdentifierSchema.optional(),
		usage: modelUsageSchema,
	})
	.strict();

const inheritedSubmissionSchema = z
	.object({
		failure: z.string().optional(),
		sourceMessageId: safeIdentifierSchema,
		sourceRecordId: safeIdentifierSchema,
		sourceSubmissionId: safeIdentifierSchema,
		status: z.enum(["failed", "pending", "processed", "processing"]),
		targetMessageId: safeIdentifierSchema,
		targetRecordId: safeIdentifierSchema,
		targetSubmissionId: safeIdentifierSchema,
	})
	.strict();

const sessionForkedPayloadSchema = z
	.object({
		sourceLogId: safeIdentifierSchema,
		sourceMessageId: safeIdentifierSchema,
		sourceRecordId: safeIdentifierSchema,
		sourceSequence: z.number().int().positive(),
		sourceSessionId: safeIdentifierSchema,
		sourceTurnId: safeIdentifierSchema,
		targetMessageId: safeIdentifierSchema,
		targetRecordId: safeIdentifierSchema,
		targetTurnId: safeIdentifierSchema,
		inheritedRecordIds: z.array(safeIdentifierSchema),
		inheritedCompactionIds: z.array(safeIdentifierSchema),
		inheritedSubmissions: z.array(inheritedSubmissionSchema),
		inheritedUsage: z.array(inheritedUsageContributionSchema),
	})
	.strict();

export type SessionForkedPayload = z.infer<typeof sessionForkedPayloadSchema>;

export const parseSessionForkedPayload = (
	value: unknown
): SessionForkedPayload => sessionForkedPayloadSchema.parse(value);

const usageCommittedPayloadSchema = z
	.object({
		compactionId: safeIdentifierSchema.nullable().optional(),
		costUsd: z.number().finite().nonnegative().nullable().optional(),
		createdAt: z.string().datetime(),
		id: safeIdentifierSchema,
		kind: z.enum(["cache-warm", "compaction-summary"]),
		model: providerModelSelectionSchema,
		usage: modelUsageSchema,
	})
	.strict()
	.refine(
		(payload) =>
			payload.compactionId === undefined ||
			(payload.kind === "compaction-summary") ===
				(payload.compactionId !== null)
	);

const eventPayloadSchemas: Readonly<
	Record<Exclude<SessionLogEventType, "session.header">, z.ZodType>
> = {
	"session.created": createdPayloadSchema,
	"session.metadata-updated": metadataUpdatedPayloadSchema,
	"record.committed": recordCommittedPayloadSchema,
	"context.edited": sessionContextEditSchema,
	"submission.status-updated": submissionStatusPayloadSchema,
	"compaction.committed": compactionPayloadSchema,
	"usage.committed": usageCommittedPayloadSchema,
	"session.activation-confirmed": z
		.object({ bundleIdentity: z.string().regex(SESSION_LOG_HASH_PATTERN) })
		.strict(),
	"session.forked": sessionForkedPayloadSchema,
	"session.deleted": z.object({}).strict(),
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
			.map(([key, item]) => [key, canonicalValue(item)])
	);
};

export const encodeCanonicalSessionJson = (value: unknown): string => {
	const canonical = canonicalValue(value);
	if (
		canonical === undefined ||
		typeof canonical === "function" ||
		typeof canonical === "symbol"
	) {
		throw new Error("Session JSONL values must be JSON serializable.");
	}
	return stableStringifyJson(canonical);
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
	offset: number,
	expectedSequence: number
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
			{ offset, sequence: expectedSequence }
		);
	}
	if (bytes.at(-1) === 0x0d) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log framing requires LF without a preceding CR.",
			{ offset, sequence: expectedSequence }
		);
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains an invalid complete UTF-8 JSON line.",
			{ offset, sequence: expectedSequence }
		);
	}
};

const parseEnvelopeLine = (
	parsedJson: unknown,
	sessionId: SessionId,
	offset: number,
	expectedSequence: number
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
			{ offset, sequence: expectedSequence }
		);
	}
	const parsedEnvelope = envelopeSchema.safeParse(parsedJson);
	if (!parsedEnvelope.success) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains an invalid envelope.",
			{ offset, sequence: expectedSequence }
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
	offset: number,
	expectedSequence: number
): SessionLogEnvelope => {
	const parsedJson = parseUtf8JsonLine(
		bytes,
		sessionId,
		offset,
		expectedSequence
	);
	const envelope = parseEnvelopeLine(
		parsedJson,
		sessionId,
		offset,
		expectedSequence
	);
	validateEventLine(envelope, sessionId, offset);
	return envelope;
};

const nextLineEnd = (
	bytes: Uint8Array,
	sessionId: SessionId,
	offset: number,
	expectedSequence: number
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
			{ offset, sequence: expectedSequence }
		);
	}
	if (lineEnd === offset) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains an empty complete line.",
			{ offset, sequence: expectedSequence }
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

export type SessionLogDecodeOptions = Readonly<{
	validateSubmissionStatusTransitions?: boolean;
}>;

type SessionLogReferenceState = {
	compactionIds: Set<string>;
	compactionSequence: number;
	messageIds: Set<SessionMessageId>;
	messages: Map<SessionMessageId, SessionRecord["messages"][number]>;
	submissionStatuses: Map<string, SessionSubmissionStatus>;
	validateSubmissionStatusTransitions: boolean;
	pendingJoinedTurnReferences: Readonly<{
		entry: SessionLogEntry;
		turnId: string;
	}>[];
	priorCompactionId: string | null;
	records: Map<string, SessionRecord>;
	turnIds: Set<string>;
	usageIds: Set<string>;
};

const rejectInvalidSessionLogReference = (
	entry: SessionLogEntry,
	sessionId: SessionId,
	message: string
): never => {
	throw new SessionLogError("session_log_corrupt", sessionId, message, {
		offset: entry.startOffset,
		sequence: entry.envelope.sequence,
	});
};

const validateRecordContextReferences = (
	entry: SessionLogEntry,
	sessionId: SessionId,
	message: SessionRecord["messages"][number],
	state: SessionLogReferenceState
): void => {
	const sourceUserMessageId = message.metadata?.sourceUserMessageId;
	if (
		sourceUserMessageId !== undefined &&
		state.messages.get(sourceUserMessageId as SessionMessageId)?.role !== "user"
	) {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			"Session Record context refers to a missing source User Message."
		);
	}
	const joinedTurnId = message.metadata?.joinedTurnId;
	if (joinedTurnId !== undefined && !state.turnIds.has(String(joinedTurnId))) {
		state.pendingJoinedTurnReferences.push({
			entry,
			turnId: String(joinedTurnId),
		});
	}
};

const addSessionRecordReferences = (
	entry: SessionLogEntry,
	sessionId: SessionId,
	recordValue: unknown,
	state: SessionLogReferenceState
): void => {
	if (!isSessionRecord(recordValue)) {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			"Session log contains an invalid retained record."
		);
	}
	const record = recordValue as SessionRecord;
	if (state.records.has(record.id)) {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			"Session log contains a duplicate retained record identity."
		);
	}
	for (const message of record.messages) {
		if (state.messageIds.has(message.id)) {
			rejectInvalidSessionLogReference(
				entry,
				sessionId,
				"Session log contains a duplicate retained message identity."
			);
		}
		validateRecordContextReferences(entry, sessionId, message, state);
		if (
			message.role === "user" &&
			message.metadata?.submissionId !== undefined
		) {
			state.submissionStatuses.set(
				`${record.id}\0${message.id}\0${message.metadata.submissionId}`,
				message.metadata.submissionStatus ?? "pending"
			);
		}
		state.messageIds.add(message.id);
		state.messages.set(message.id, message);
	}
	state.records.set(record.id, record);
	state.turnIds.add(String(record.turnId));
};

const allowedSubmissionStatusTransitions: Readonly<
	Record<SessionSubmissionStatus, readonly SessionSubmissionStatus[]>
> = {
	failed: ["failed", "processing"],
	pending: ["failed", "processing"],
	processed: [],
	processing: ["failed", "processed"],
};

const validateSubmissionReferences = (
	entry: SessionLogEntry,
	sessionId: SessionId,
	state: SessionLogReferenceState
): void => {
	const payload = parseSessionSubmissionStatusPayload(entry.envelope.payload);
	const record = state.records.get(payload.recordId);
	const message = state.messages.get(payload.messageId as SessionMessageId);
	if (
		record === undefined ||
		message?.role !== "user" ||
		!record.messages.some(({ id }) => id === message.id) ||
		message.metadata?.submissionId !== payload.submissionId
	) {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			"Submission status references a missing or inconsistent User Message."
		);
	}
	const reference = `${payload.recordId}\0${payload.messageId}\0${payload.submissionId}`;
	const previousStatus = state.submissionStatuses.get(reference);
	if (
		state.validateSubmissionStatusTransitions &&
		(previousStatus === undefined ||
			!allowedSubmissionStatusTransitions[previousStatus].includes(
				payload.status
			))
	) {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			previousStatus === undefined
				? "Submission status references a missing or inconsistent User Message."
				: `Session log contains an invalid Submission status transition: ${previousStatus} -> ${payload.status}.`
		);
	}
	state.submissionStatuses.set(reference, payload.status);
};

const validateCompactionReferences = (
	entry: SessionLogEntry,
	sessionId: SessionId,
	state: SessionLogReferenceState
): void => {
	const payload = parseSessionCompactionPayload(entry.envelope.payload);
	if (
		state.compactionIds.has(payload.id) ||
		payload.sequence !== state.compactionSequence + 1 ||
		payload.priorCompactionId !== state.priorCompactionId
	) {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			"Session log contains a broken compaction identity chain."
		);
	}
	try {
		assertCompactionMessageReferences(
			{
				firstKeptUiMessageId: payload.firstKeptUiMessageId as SessionMessageId,
				id: payload.id as CompactionId,
				summary: payload.summary as unknown as SessionCompaction["summary"],
				throughMessageUiId: payload.throughMessageUiId as SessionMessageId,
			},
			state.messageIds
		);
	} catch {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			"Session log compaction references do not resolve to retained messages."
		);
	}
	state.compactionIds.add(payload.id);
	state.compactionSequence = payload.sequence;
	state.priorCompactionId = payload.id;
};

const validateUsageReferences = (
	entry: SessionLogEntry,
	sessionId: SessionId,
	state: SessionLogReferenceState
): void => {
	const payload = usageCommittedPayloadSchema.parse(entry.envelope.payload);
	if (state.usageIds.has(payload.id)) {
		rejectInvalidSessionLogReference(
			entry,
			sessionId,
			"Session log contains a duplicate Usage Entry identity."
		);
	}
	state.usageIds.add(payload.id);
};

const validateSessionLogReferences = (
	entries: readonly SessionLogEntry[],
	sessionId: SessionId,
	options: SessionLogDecodeOptions
): void => {
	const state: SessionLogReferenceState = {
		compactionIds: new Set(),
		compactionSequence: 0,
		messageIds: new Set(),
		messages: new Map(),
		pendingJoinedTurnReferences: [],
		priorCompactionId: null,
		records: new Map(),
		submissionStatuses: new Map(),
		validateSubmissionStatusTransitions:
			options.validateSubmissionStatusTransitions ?? false,
		turnIds: new Set(),
		usageIds: new Set(),
	};
	for (const entry of entries) {
		const record = recordFromEventPayload(
			entry.envelope.type,
			entry.envelope.payload
		);
		if (record !== undefined) {
			addSessionRecordReferences(entry, sessionId, record, state);
		}
		switch (entry.envelope.type) {
			case "context.edited": {
				const edit = sessionContextEditSchema.parse(entry.envelope.payload);
				if (
					edit.operationId !== entry.envelope.operationId ||
					!state.messageIds.has(edit.targetId)
				) {
					rejectInvalidSessionLogReference(
						entry,
						sessionId,
						"Context edit references a missing message or inconsistent operation identity."
					);
				}
				break;
			}
			case "submission.status-updated":
				validateSubmissionReferences(entry, sessionId, state);
				break;
			case "compaction.committed":
				validateCompactionReferences(entry, sessionId, state);
				break;
			case "usage.committed":
				validateUsageReferences(entry, sessionId, state);
				break;
			default:
				break;
		}
	}
	for (const reference of state.pendingJoinedTurnReferences) {
		if (!state.turnIds.has(reference.turnId)) {
			rejectInvalidSessionLogReference(
				reference.entry,
				sessionId,
				"Session Record context refers to a missing joined Agent Turn."
			);
		}
	}
};

const isValidForkTargetCheckpoint = (
	targetRecord: SessionRecord | undefined,
	targetMessage: SessionRecord["messages"][number] | undefined
): boolean =>
	targetRecord !== undefined &&
	targetRecord.messages.length === 1 &&
	targetMessage !== undefined &&
	((targetRecord.outcome.kind === "user" && targetMessage.role === "user") ||
		(targetRecord.outcome.kind === "tool" &&
			targetMessage.role === "assistant" &&
			targetMessage.parts.some(isSessionToolCallPart)) ||
		(targetRecord.outcome.kind === "assistant" &&
			targetRecord.outcome.terminal.kind === "completed" &&
			targetMessage.role === "assistant"));

const collectForkLogReferences = (
	entries: readonly SessionLogEntry[]
): Readonly<{
	compactionIds: ReadonlySet<string>;
	records: ReadonlyMap<string, SessionRecord>;
}> => {
	const records = new Map<string, SessionRecord>();
	const compactionIds = new Set<string>();
	for (const entry of entries) {
		const { payload, type } = entry.envelope;
		if (type === "session.created" || type === "record.committed") {
			const candidate = recordFromEventPayload(type, payload);
			if (candidate !== undefined && isSessionRecord(candidate)) {
				records.set(String(candidate.id), candidate);
			}
		}
		if (type === "compaction.committed") {
			compactionIds.add(String(payload.id));
		}
	}
	return { compactionIds, records };
};

const hasValidForkProvenanceReferences = (
	payload: SessionForkedPayload,
	records: ReadonlyMap<string, SessionRecord>,
	compactionIds: ReadonlySet<string>,
	targetRecord: SessionRecord | undefined,
	targetMessage: SessionRecord["messages"][number] | undefined
): boolean => {
	const inheritedRecordIds = new Set(payload.inheritedRecordIds);
	const inheritedCompactionIds = new Set(payload.inheritedCompactionIds);
	const targetSubmissionIds = new Set(
		payload.inheritedSubmissions.map(
			({ targetSubmissionId }) => targetSubmissionId
		)
	);
	const inheritedSubmissionsAreValid = payload.inheritedSubmissions.every(
		(submission) => {
			const record = records.get(submission.targetRecordId);
			const message = record?.messages.find(
				({ id }) => String(id) === submission.targetMessageId
			);
			return (
				message?.role === "user" &&
				message.metadata?.submissionId === submission.targetSubmissionId &&
				record !== undefined &&
				inheritedRecordIds.has(submission.targetRecordId)
			);
		}
	);
	return (
		targetRecord !== undefined &&
		targetMessage !== undefined &&
		isValidForkTargetCheckpoint(targetRecord, targetMessage) &&
		String(targetRecord.turnId) === payload.targetTurnId &&
		inheritedRecordIds.size === payload.inheritedRecordIds.length &&
		inheritedCompactionIds.size === payload.inheritedCompactionIds.length &&
		targetSubmissionIds.size === payload.inheritedSubmissions.length &&
		inheritedRecordIds.has(payload.targetRecordId) &&
		payload.inheritedRecordIds.every((id) => records.has(id)) &&
		payload.inheritedCompactionIds.every((id) => compactionIds.has(id)) &&
		inheritedSubmissionsAreValid
	);
};

const validateForkProvenanceReferences = (
	entries: readonly SessionLogEntry[],
	sessionId: SessionId
): void => {
	const forkEntries = entries.filter(
		({ envelope }) => envelope.type === "session.forked"
	);
	if (forkEntries.length === 0) {
		return;
	}
	const forkEntry = forkEntries[0];
	if (
		forkEntries.length !== 1 ||
		forkEntry?.envelope.type !== "session.forked"
	) {
		const entry = forkEntry ?? entries[0];
		if (entry === undefined) {
			return;
		}
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains multiple fork provenance checkpoints.",
			{ offset: entry.startOffset, sequence: entry.envelope.sequence }
		);
	}

	const { compactionIds, records } = collectForkLogReferences(entries);
	const payload = parseSessionForkedPayload(forkEntry.envelope.payload);
	const targetRecord = records.get(payload.targetRecordId);
	const targetMessage = targetRecord?.messages.find(
		({ id }) => String(id) === payload.targetMessageId
	);
	if (
		!hasValidForkProvenanceReferences(
			payload,
			records,
			compactionIds,
			targetRecord,
			targetMessage
		)
	) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session fork provenance references missing or inconsistent target records or compactions.",
			{
				offset: forkEntry.startOffset,
				sequence: forkEntry.envelope.sequence,
			}
		);
	}
};

export const decodeSessionLog = (
	sessionId: SessionId,
	bytes: Uint8Array,
	options: SessionLogDecodeOptions = {}
): SessionLogState => {
	const entries: SessionLogEntry[] = [];
	const operationDigests = new Map<string, string>();
	let offset = 0;
	let expectedSequence = 0;
	let previousHash: string | null = null;
	let logId: string | undefined;
	let deleted = false;
	while (offset < bytes.byteLength) {
		const lineEnd = nextLineEnd(bytes, sessionId, offset, expectedSequence);
		const envelope = parseLine(
			bytes.subarray(offset, lineEnd),
			sessionId,
			offset,
			expectedSequence
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
			"Session log is missing its header or creation checkpoint.",
			{ offset, sequence: expectedSequence }
		);
	}
	validateSessionLogReferences(entries, sessionId, options);
	validateForkProvenanceReferences(entries, sessionId);
	return {
		entries,
		lastHash: previousHash,
		logId,
		nextOffset: bytes.byteLength,
		nextSequence: expectedSequence,
	};
};

export const decodeSessionLogSuffix = (
	sessionId: SessionId,
	bytes: Uint8Array,
	cursor: SessionProjectionCursor
): SessionLogState => {
	if (cursor.nextSequence < 1) {
		throw new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session projection cursor does not include the log header.",
			{ offset: cursor.nextByteOffset, sequence: cursor.nextSequence }
		);
	}
	const entries: SessionLogEntry[] = [];
	const operationDigests = new Map<string, string>();
	let offset = 0;
	let expectedSequence = cursor.nextSequence;
	let previousHash: string | null = cursor.lastHash;
	let deleted = false;
	while (offset < bytes.byteLength) {
		const lineEnd = nextLineEnd(bytes, sessionId, offset, expectedSequence);
		const absoluteOffset = cursor.nextByteOffset + offset;
		const envelope = parseLine(
			bytes.subarray(offset, lineEnd),
			sessionId,
			absoluteOffset,
			expectedSequence
		);
		assertSequenceAndPredecessor(
			envelope,
			expectedSequence,
			previousHash,
			sessionId,
			absoluteOffset
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
				{ offset: absoluteOffset, sequence: envelope.sequence }
			);
		}
		if (envelope.type === "session.deleted") {
			deleted = true;
		}
		registerUniqueOperation(
			envelope,
			operationDigests,
			sessionId,
			absoluteOffset
		);
		const endOffset = cursor.nextByteOffset + lineEnd + 1;
		entries.push({ envelope, endOffset, startOffset: absoluteOffset });
		offset = lineEnd + 1;
		expectedSequence += 1;
		previousHash = envelope.entryHash;
	}
	return {
		entries,
		lastHash: previousHash,
		logId: cursor.logId,
		nextOffset: cursor.nextByteOffset + bytes.byteLength,
		nextSequence: expectedSequence,
	};
};

export const sessionLogOperationDigest = semanticOperationDigest;

export const isSessionRecord = (value: unknown): value is SessionRecord =>
	getSessionRecordValidationError(value) === null;
