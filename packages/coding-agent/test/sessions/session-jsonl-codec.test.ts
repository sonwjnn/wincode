import { expect, test } from "bun:test";
import { toSubmissionId } from "@wincode/agent-core";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { createSessionUserMessage } from "@/modules/sessions/message";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	decodeSessionLog,
	decodeSessionLogSuffix,
	encodeSessionLogLine,
	type SessionLogEventType,
} from "@/modules/sessions/storage/session-jsonl-codec";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import { toSessionId } from "@/shared/identifiers";
import { agentId, agentTurnId, sessionMessageId } from "../support/identifiers";

const sessionId = toSessionId("codec-contract");
const timestamp = "2025-02-03T04:05:06.000Z";
const HASH_MISMATCH = /Session log entry hash does not match/u;
const MISSING_LF = /without LF framing/u;
const SAFE_IDENTIFIER_ERROR = /safe identifier/u;
const RESURRECTION_AFTER_DELETION = /entry after its deletion checkpoint/u;

const createLog = (title: string) => {
	const header = createSessionLogHeader(sessionId, "log-identity", timestamp);
	const created = createSessionLogEvent({
		operationId: "create-codec-contract",
		payload: {
			createdAt: timestamp,
			editMode: "hashline",
			lastMessageAt: null,
			pinned: false,
			title,
		},
		previousHash: header.entryHash,
		sequence: 1,
		sessionId,
		timestamp,
		type: "session.created",
	});
	const headerBytes = encodeSessionLogLine(header);
	const createdBytes = encodeSessionLogLine(created);
	return {
		bytes: new Uint8Array([...headerBytes, ...createdBytes]),
		createdBytes,
		headerBytes,
	};
};

const createUserRecord = (messageId: string, turnId: string) =>
	buildUserSessionRecord({
		agentId: agentId("codec-reference-agent"),
		message: createSessionUserMessage(
			"Durable user record",
			undefined,
			[],
			[],
			sessionMessageId(messageId)
		),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId(turnId),
	});

const reverseJsonObjectKeys = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(reverseJsonObjectKeys);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, nestedValue]) => [key, reverseJsonObjectKeys(nestedValue)])
	);
};

test("equivalent Session records with reordered JSON keys keep identical durable bytes", () => {
	const record = createUserRecord(
		"codec-canonical-order-message",
		"codec-canonical-order-turn"
	);
	const createEvent = (record: unknown) =>
		createSessionLogEvent({
			operationId: "canonical-order-record-operation",
			payload: { record },
			previousHash: "a".repeat(64),
			sequence: 2,
			sessionId,
			timestamp,
			type: "record.committed",
		});
	const event = createEvent(record);
	const reorderedEvent = createEvent(reverseJsonObjectKeys(record));

	expect(reorderedEvent.entryHash).toBe(event.entryHash);
	expect(encodeSessionLogLine(reorderedEvent)).toEqual(
		encodeSessionLogLine(event)
	);
});

const appendValidLogEvent = (
	bytes: Uint8Array,
	operationId: string,
	type: SessionLogEventType,
	payload: Readonly<Record<string, unknown>>
): Uint8Array => {
	const state = decodeSessionLog(sessionId, bytes);
	const previous = state.entries.at(-1)?.envelope;
	if (previous === undefined) {
		throw new Error("Expected a previous Session log entry.");
	}
	const event = createSessionLogEvent({
		operationId,
		payload,
		previousHash: previous.entryHash,
		sequence: previous.sequence + 1,
		sessionId,
		timestamp,
		type,
	});
	return new Uint8Array([...bytes, ...encodeSessionLogLine(event)]);
};

test("Session log encoding rejects identifiers ending in terminal line separators", () => {
	const sessionIdWithTrailingCarriageReturn = toSessionId("codec-contract\r");

	expect(() =>
		createSessionLogHeader(
			sessionIdWithTrailingCarriageReturn,
			"log-identity",
			timestamp
		)
	).toThrow(SAFE_IDENTIFIER_ERROR);
});

test("UTF-8 byte offsets and hash linkage remain correct for non-ASCII Session text", () => {
	const { bytes, createdBytes, headerBytes } = createLog("Resume 🌊 café");
	const state = decodeSessionLog(sessionId, bytes);

	expect(
		state.entries.map(({ startOffset, endOffset }) => [startOffset, endOffset])
	).toEqual([
		[0, headerBytes.byteLength],
		[headerBytes.byteLength, headerBytes.byteLength + createdBytes.byteLength],
	]);
	expect(state.entries[1]?.envelope.previousHash).toBe(
		state.entries[0]?.envelope.entryHash
	);
	expect(state.nextOffset).toBe(bytes.byteLength);
});

test("suffix replay resumes from the projection cursor and keeps absolute byte offsets", () => {
	const prefix = createLog("suffix cursor");
	const record = createUserRecord("codec-suffix-message", "codec-suffix-turn");
	const bytes = appendValidLogEvent(
		prefix.bytes,
		`record-${record.id}`,
		"record.committed",
		{ record }
	);
	const prefixState = decodeSessionLog(sessionId, prefix.bytes);
	const lastPrefixEntry = prefixState.entries.at(-1);
	if (lastPrefixEntry === undefined) {
		throw new Error("Expected a committed prefix entry.");
	}
	const cursor = {
		generation: 1,
		lastHash: lastPrefixEntry.envelope.entryHash,
		logId: prefixState.logId,
		nextByteOffset: prefixState.nextOffset,
		nextSequence: prefixState.nextSequence,
	};
	const suffix = bytes.subarray(cursor.nextByteOffset);
	const state = decodeSessionLogSuffix(sessionId, suffix, cursor);

	expect(state.entries).toHaveLength(1);
	expect(state.entries[0]).toMatchObject({
		startOffset: prefix.bytes.byteLength,
		envelope: { sequence: cursor.nextSequence, type: "record.committed" },
	});
	expect(state.nextOffset).toBe(bytes.byteLength);

	const invalidEvent = createSessionLogEvent({
		operationId: "disconnected-suffix-entry",
		payload: { title: "Invalid predecessor" },
		previousHash: "not-the-cursor-hash",
		sequence: cursor.nextSequence,
		sessionId,
		timestamp,
		type: "session.metadata-updated",
	});
	let failure: unknown;
	try {
		decodeSessionLogSuffix(
			sessionId,
			encodeSessionLogLine(invalidEvent),
			cursor
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({
		code: "session_log_corrupt",
		offset: cursor.nextByteOffset,
		sequence: cursor.nextSequence,
	});
});

test("complete malformed JSON and envelopes report the expected sequence and byte offset", () => {
	const header = createSessionLogHeader(sessionId, "log-identity", timestamp);
	const headerBytes = encodeSessionLogLine(header);
	for (const invalidLine of ["{", '{"formatVersion":1}']) {
		const invalidBytes = new TextEncoder().encode(`${invalidLine}\n`);
		let failure: unknown;
		try {
			decodeSessionLog(
				sessionId,
				new Uint8Array([...headerBytes, ...invalidBytes])
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			code: "session_log_corrupt",
			offset: headerBytes.byteLength,
			sequence: 1,
		});
	}
});

test("replay rejects Submission status references to missing records", () => {
	const bytes = appendValidLogEvent(
		createLog("missing submission target").bytes,
		"missing-submission-status-target",
		"submission.status-updated",
		{
			messageId: "missing-message",
			recordId: "missing-record",
			status: "processing",
			submissionId: "missing-submission",
		}
	);

	expect(() => decodeSessionLog(sessionId, bytes)).toThrow(
		"Submission status references a missing or inconsistent User Message."
	);
});

test("replay rejects Submission status IDs that differ from the User Message", () => {
	const messageId = sessionMessageId("codec-submission-message");
	const record = buildUserSessionRecord({
		agentId: agentId("codec-submission-agent"),
		message: createSessionUserMessage(
			"Submission with a durable identity",
			{
				submissionId: toSubmissionId("codec-submission-id"),
				submissionStatus: "pending",
			},
			[],
			[],
			messageId
		),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("codec-submission-turn"),
	});
	const withRecord = appendValidLogEvent(
		createLog("submission identity mismatch").bytes,
		`record-${record.id}`,
		"record.committed",
		{ record }
	);
	const bytes = appendValidLogEvent(
		withRecord,
		"submission-status-wrong-identity",
		"submission.status-updated",
		{
			messageId,
			recordId: record.id,
			status: "processing",
			submissionId: "different-submission-id",
		}
	);

	expect(() => decodeSessionLog(sessionId, bytes)).toThrow(
		"Submission status references a missing or inconsistent User Message."
	);
});

test("replay rejects a processed Submission status returning to pending", () => {
	const submissionId = toSubmissionId("codec-processed-submission");
	const messageId = sessionMessageId("codec-processed-submission-message");
	const record = buildUserSessionRecord({
		agentId: agentId("codec-processed-submission-agent"),
		message: createSessionUserMessage(
			"A processed submission cannot become pending again",
			{ submissionId, submissionStatus: "processed" },
			[],
			[],
			messageId
		),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("codec-processed-submission-turn"),
	});
	const withRecord = appendValidLogEvent(
		createLog("invalid submission status transition").bytes,
		`record-${record.id}`,
		"record.committed",
		{ record }
	);
	const bytes = appendValidLogEvent(
		withRecord,
		"processed-submission-returned-to-pending",
		"submission.status-updated",
		{
			messageId,
			recordId: record.id,
			status: "pending",
			submissionId,
		}
	);

	expect(() =>
		decodeSessionLog(sessionId, bytes, {
			validateSubmissionStatusTransitions: true,
		})
	).toThrow("invalid Submission status transition: processed -> pending");
});

test("replay rejects duplicate retained record and message identities", () => {
	const initialLog = createLog("duplicate identity").bytes;
	const firstRecord = createUserRecord(
		"codec-duplicate-message",
		"codec-duplicate-turn"
	);
	const logWithRecord = appendValidLogEvent(
		initialLog,
		`record-${firstRecord.id}`,
		"record.committed",
		{ record: firstRecord }
	);
	const duplicateRecordLog = appendValidLogEvent(
		logWithRecord,
		"duplicate-retained-record-operation",
		"record.committed",
		{ record: firstRecord }
	);
	const differentRecordWithDuplicateMessage = createUserRecord(
		"codec-duplicate-message",
		"codec-other-turn"
	);
	const duplicateMessageLog = appendValidLogEvent(
		logWithRecord,
		`record-${differentRecordWithDuplicateMessage.id}`,
		"record.committed",
		{ record: differentRecordWithDuplicateMessage }
	);

	expect(() => decodeSessionLog(sessionId, duplicateRecordLog)).toThrow(
		"duplicate retained record identity"
	);
	expect(() => decodeSessionLog(sessionId, duplicateMessageLog)).toThrow(
		"duplicate retained message identity"
	);
});

test("replay rejects Session Record context references to missing Agent Turns", () => {
	const record = buildUserSessionRecord({
		agentId: agentId("codec-context-agent"),
		message: createSessionUserMessage(
			"Context with a missing joined turn",
			{ joinedTurnId: agentTurnId("missing-joined-turn") },
			[],
			[],
			sessionMessageId("codec-context-message")
		),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("codec-context-turn"),
	});
	const bytes = appendValidLogEvent(
		createLog("missing context target").bytes,
		"missing-context-turn-target",
		"record.committed",
		{ record }
	);

	expect(() => decodeSessionLog(sessionId, bytes)).toThrow(
		"Session Record context refers to a missing joined Agent Turn."
	);
});

test("replay accepts a joined-turn reference when its Agent Turn is committed later", () => {
	const futureTurnId = agentTurnId("codec-future-joined-turn");
	const joinedRecord = buildUserSessionRecord({
		agentId: agentId("codec-forward-context-agent"),
		message: createSessionUserMessage(
			"Join the active turn before its terminal record is committed.",
			{ joinedTurnId: futureTurnId },
			[],
			[],
			sessionMessageId("codec-forward-context-message")
		),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("codec-forward-context-turn"),
	});
	const futureRecord = createUserRecord(
		"codec-future-joined-message",
		String(futureTurnId)
	);
	const initialLog = createLog("forward joined-turn reference").bytes;
	const previous = decodeSessionLog(sessionId, initialLog).entries.at(
		-1
	)?.envelope;
	if (previous === undefined) {
		throw new Error("Expected a creation entry before context records.");
	}
	const joinedEntry = createSessionLogEvent({
		operationId: "forward-joined-turn-context",
		payload: { record: joinedRecord },
		previousHash: previous.entryHash,
		sequence: previous.sequence + 1,
		sessionId,
		timestamp,
		type: "record.committed",
	});
	const futureEntry = createSessionLogEvent({
		operationId: "forward-joined-turn-target",
		payload: { record: futureRecord },
		previousHash: joinedEntry.entryHash,
		sequence: joinedEntry.sequence + 1,
		sessionId,
		timestamp,
		type: "record.committed",
	});
	const bytes = new Uint8Array([
		...initialLog,
		...encodeSessionLogLine(joinedEntry),
		...encodeSessionLogLine(futureEntry),
	]);

	expect(decodeSessionLog(sessionId, bytes).entries.slice(-2)).toHaveLength(2);
});

test("replay rejects compaction boundaries that reference missing messages", () => {
	const bytes = appendValidLogEvent(
		createLog("missing compaction target").bytes,
		"missing-compaction-message-target",
		"compaction.committed",
		{
			completedAt: timestamp,
			createdAt: timestamp,
			estimatedTokensAfter: 0,
			firstKeptAssistantPartIndex: null,
			firstKeptUiMessageId: "missing-kept-message",
			focus: null,
			id: "missing-message-compaction",
			priorCompactionId: null,
			sequence: 1,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summarizationThinkingLevel: null,
			summarizationUsage: null,
			summary: {
				coveredMessageIds: [],
				formatVersion: 1,
				text: "Summary",
			},
			tokensBefore: 0,
			trigger: "manual",
			throughMessageUiId: "missing-through-message",
		}
	);

	expect(() => decodeSessionLog(sessionId, bytes)).toThrow(
		"Session log compaction references do not resolve to retained messages."
	);
});

test("complete hash corruption is rejected rather than silently skipped", () => {
	const { bytes } = createLog("valid text");
	const corrupted = bytes.slice();
	const search = new TextEncoder().encode("valid text");
	const textOffset = corrupted.findIndex((_, index) =>
		search.every((value, innerIndex) => corrupted[index + innerIndex] === value)
	);
	corrupted[textOffset + search.byteLength - 1] = 0x78;

	expect(() => decodeSessionLog(sessionId, corrupted)).toThrow(HASH_MISMATCH);
});

test("a truncated line reports its expected sequence and byte offset", () => {
	const { bytes, headerBytes } = createLog("valid text");
	const truncated = bytes.subarray(0, bytes.byteLength - 1);
	let failure: unknown;
	try {
		decodeSessionLog(sessionId, truncated);
	} catch (error) {
		failure = error;
	}

	expect(failure).toMatchObject({
		code: "session_log_truncated",
		offset: headerBytes.byteLength,
		sequence: 1,
	});
	expect(() => decodeSessionLog(sessionId, truncated)).toThrow(MISSING_LF);
});

test("a missing header or creation checkpoint reports the expected sequence and offset", () => {
	const header = createSessionLogHeader(sessionId, "log-identity", timestamp);
	const headerBytes = encodeSessionLogLine(header);
	for (const [bytes, offset, sequence] of [
		[new Uint8Array(), 0, 0],
		[headerBytes, headerBytes.byteLength, 1],
	] as const) {
		let failure: unknown;
		try {
			decodeSessionLog(sessionId, bytes);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			code: "session_log_corrupt",
			offset,
			sequence,
		});
	}
});

test("a complete checkpoint after deletion is rejected rather than resurrecting the Session", () => {
	const { bytes } = createLog("valid text");
	const state = decodeSessionLog(sessionId, bytes);
	const created = state.entries[1]?.envelope;
	if (created === undefined) {
		throw new Error("Expected a creation checkpoint.");
	}
	const deleted = createSessionLogEvent({
		operationId: "delete-codec-contract",
		payload: {},
		previousHash: created.entryHash,
		sequence: 2,
		sessionId,
		timestamp,
		type: "session.deleted",
	});
	const resurrected = createSessionLogEvent({
		operationId: "resurrect-codec-contract",
		payload: created.payload,
		previousHash: deleted.entryHash,
		sequence: 3,
		sessionId,
		timestamp,
		type: "session.created",
	});
	const invalidLog = new Uint8Array([
		...bytes,
		...encodeSessionLogLine(deleted),
		...encodeSessionLogLine(resurrected),
	]);

	expect(() => decodeSessionLog(sessionId, invalidLog)).toThrow(
		RESURRECTION_AFTER_DELETION
	);
});

test("format-v1 usage events without cost snapshots remain readable", () => {
	const { bytes } = createLog("legacy usage");
	const state = decodeSessionLog(sessionId, bytes);
	const previous = state.entries.at(-1)?.envelope;
	if (previous === undefined) {
		throw new Error("Expected a Session creation entry.");
	}
	const payload = {
		createdAt: timestamp,
		id: "legacy-summary-usage",
		kind: "compaction-summary" as const,
		model: { modelId: "gpt-4o", providerId: "openai" },
		usage: { inputTokens: 12, outputTokens: 3 },
	};
	const usage = createSessionLogEvent({
		operationId: "legacy-summary-usage-operation",
		payload,
		previousHash: previous.entryHash,
		sequence: previous.sequence + 1,
		sessionId,
		timestamp,
		type: "usage.committed",
	});
	const replayed = decodeSessionLog(
		sessionId,
		new Uint8Array([...bytes, ...encodeSessionLogLine(usage)])
	);

	expect(replayed.entries.at(-1)?.envelope.payload).toEqual(payload);
});

test("a compaction-summary Usage event may reference the following Compaction checkpoint", () => {
	const messageId = "usage-before-compaction-message";
	const record = createUserRecord(messageId, "usage-before-compaction-turn");
	const withRecord = appendValidLogEvent(
		createLog("usage before compaction").bytes,
		"usage-before-compaction-record",
		"record.committed",
		{ record }
	);
	const compactionId = "usage-before-compaction-checkpoint";
	const usagePayload = {
		compactionId,
		createdAt: timestamp,
		id: "usage-before-compaction-summary-usage",
		kind: "compaction-summary" as const,
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		usage: { inputTokens: 12, outputTokens: 3 },
	};
	const withUsage = appendValidLogEvent(
		withRecord,
		"usage-before-compaction-usage",
		"usage.committed",
		usagePayload
	);
	const withCompaction = appendValidLogEvent(
		withUsage,
		"usage-before-compaction-compaction",
		"compaction.committed",
		{
			completedAt: timestamp,
			createdAt: timestamp,
			estimatedTokensAfter: 5,
			firstKeptAssistantPartIndex: null,
			firstKeptUiMessageId: messageId,
			focus: null,
			id: compactionId,
			priorCompactionId: null,
			sequence: 1,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summarizationThinkingLevel: null,
			summarizationUsage: null,
			summary: {
				coveredMessageIds: [messageId],
				formatVersion: 1,
				text: "Summary for the following checkpoint.",
			},
			tokensBefore: 10,
			trigger: "manual",
			throughMessageUiId: messageId,
		}
	);
	const replayed = decodeSessionLog(sessionId, withCompaction);

	expect(
		replayed.entries.slice(-2).map(({ envelope }) => envelope.type)
	).toEqual(["usage.committed", "compaction.committed"]);
	expect(replayed.entries.at(-2)?.envelope.payload).toEqual(usagePayload);
});

test("unknown format versions fail closed before hash validation", () => {
	const { bytes, headerBytes } = createLog("valid text");
	const header = JSON.parse(
		new TextDecoder().decode(bytes.subarray(0, headerBytes.byteLength - 1))
	) as Record<string, unknown>;
	header.formatVersion = 2;
	const unsupportedHeader = new TextEncoder().encode(
		`${JSON.stringify(header)}\n`
	);
	const rest = bytes.subarray(headerBytes.byteLength);
	const log = new Uint8Array([...unsupportedHeader, ...rest]);

	try {
		decodeSessionLog(sessionId, log);
		throw new Error("Unsupported Session log format was accepted.");
	} catch (error) {
		expect(error).toMatchObject({ code: "session_log_version_unsupported" });
	}
});
