import {
	isSessionToolCallPart,
	type SessionMessageId,
	type SessionRecord,
	type SessionRecordId,
} from "@wincode/agent-core";
import { findContinuationContextMessages } from "./continuation-context";
import { projectSessionRecords } from "./transcript-projection";

export type SessionForkCheckpointKind =
	| "assistant"
	| "checkpoint"
	| "tool"
	| "user";

export type SessionForkCheckpointAssessment = Readonly<{
	kind: SessionForkCheckpointKind;
	messageId: SessionMessageId;
	recordId: SessionRecordId;
	status: "invalid" | "valid";
	reason?: string;
}>;

export type SessionForkCheckpointValidation =
	| Readonly<{
			kind: "invalid";
			reason: string;
	  }>
	| Readonly<{
			kind: "valid";
			messageId: SessionMessageId;
			record: SessionRecord;
			recordId: SessionRecordId;
	  }>;

const incompleteToolBatchReason =
	"Parallel Tool Call batch is incomplete at this checkpoint.";
const unverifiedToolBatchReason =
	"Tool Call batch membership is unavailable, so this checkpoint cannot be validated.";

const checkpointKind = (record: SessionRecord): SessionForkCheckpointKind => {
	switch (record.outcome.kind) {
		case "user":
		case "tool":
			return record.outcome.kind;
		case "checkpoint":
			return "checkpoint";
		default:
			return "assistant";
	}
};

const isSameStringSet = (
	left: ReadonlySet<string>,
	right: ReadonlySet<string>
): boolean =>
	left.size === right.size && [...left].every((value) => right.has(value));

type SessionRecordPart = SessionRecord["messages"][number]["parts"][number];
type SessionToolCallBatchProgress = {
	readonly expected: Set<string>;
	readonly completed: Set<string>;
};

const inconsistentToolBatchReason =
	"Tool Call batch membership is inconsistent at this checkpoint.";
const duplicateToolCallReason =
	"Tool Call batch contains a duplicate result at this checkpoint.";

const validateToolCallBatchPart = (
	part: SessionRecordPart,
	turnId: SessionRecord["turnId"],
	batches: Map<string, SessionToolCallBatchProgress>
): string | undefined => {
	if (!isSessionToolCallPart(part)) {
		return;
	}
	if (part.toolBatch === undefined) {
		return unverifiedToolBatchReason;
	}
	const expected = new Set(part.toolBatch.toolCallIds);
	if (!expected.has(part.toolCallId)) {
		return inconsistentToolBatchReason;
	}
	const key = `${turnId}\0${part.toolBatch.id}`;
	const existing = batches.get(key);
	if (existing === undefined) {
		batches.set(key, { completed: new Set([part.toolCallId]), expected });
		return;
	}
	if (!isSameStringSet(existing.expected, expected)) {
		return inconsistentToolBatchReason;
	}
	if (existing.completed.has(part.toolCallId)) {
		return duplicateToolCallReason;
	}
	existing.completed.add(part.toolCallId);
};

const validateToolCallBatches = (
	records: readonly SessionRecord[]
): string | undefined => {
	const batches = new Map<string, SessionToolCallBatchProgress>();
	for (const record of records) {
		for (const message of record.messages) {
			for (const part of message.parts) {
				const error = validateToolCallBatchPart(part, record.turnId, batches);
				if (error !== undefined) {
					return error;
				}
			}
		}
	}
	for (const { completed, expected } of batches.values()) {
		if (!isSameStringSet(completed, expected)) {
			return incompleteToolBatchReason;
		}
	}
};

const checkpointMessageError = (
	record: SessionRecord,
	message: SessionRecord["messages"][number],
	kind: SessionForkCheckpointKind
): string | undefined => {
	if (kind === "checkpoint") {
		return "Nonterminal assistant output is not a valid checkpoint.";
	}
	if (kind === "assistant") {
		if (
			record.outcome.kind !== "assistant" ||
			record.outcome.terminal.kind !== "completed"
		) {
			return "Only completed terminal assistant outcomes are valid checkpoints.";
		}
		if (message.role !== "assistant") {
			return "Terminal assistant checkpoint does not contain an assistant message.";
		}
	}
	if (kind === "user" && message.role !== "user") {
		return "Accepted user checkpoint does not contain a user message.";
	}
	if (
		kind === "tool" &&
		(record.outcome.kind !== "tool" ||
			message.role !== "assistant" ||
			!message.parts.some(isSessionToolCallPart))
	) {
		return "Completed Tool Call checkpoint does not contain a Tool Call result.";
	}
};

const continuationCheckpointError = (
	prefix: readonly SessionRecord[],
	record: SessionRecord,
	message: SessionRecord["messages"][number],
	kind: SessionForkCheckpointKind
): string | undefined => {
	const context = projectSessionRecords(prefix);
	const continuation = findContinuationContextMessages(context, {
		...(kind === "assistant" ? { terminalAssistantMessageId: message.id } : {}),
	});
	if (continuation.kind === "ready" && prefix.at(-1)?.id === record.id) {
		return;
	}
	if (continuation.kind === "rejected") {
		return continuation.reason;
	}
	return "Checkpoint does not end a valid Session context prefix.";
};

/** Validates one record cut using the same context boundary as continuation. */
export const assessSessionForkCheckpoint = (
	records: readonly SessionRecord[],
	recordId: SessionRecordId
): SessionForkCheckpointValidation => {
	const index = records.findIndex((record) => record.id === recordId);
	if (index === -1) {
		return { kind: "invalid", reason: "Checkpoint Record was not found." };
	}
	const record = records[index];
	if (record === undefined) {
		return { kind: "invalid", reason: "Checkpoint Record was not found." };
	}
	const message = record.messages[0];
	if (message === undefined || record.messages.length !== 1) {
		return {
			kind: "invalid",
			reason: "A Session checkpoint cannot split a multi-message record.",
		};
	}
	const kind = checkpointKind(record);
	const messageError = checkpointMessageError(record, message, kind);
	if (messageError !== undefined) {
		return { kind: "invalid", reason: messageError };
	}
	const prefix = records.slice(0, index + 1);
	const toolBatchError = validateToolCallBatches(prefix);
	if (toolBatchError !== undefined) {
		return { kind: "invalid", reason: toolBatchError };
	}
	const continuationError = continuationCheckpointError(
		prefix,
		record,
		message,
		kind
	);
	if (continuationError !== undefined) {
		return { kind: "invalid", reason: continuationError };
	}
	return { kind: "valid", messageId: message.id, record, recordId: record.id };
};

/** Enumerates visible record boundaries and includes stable refusal reasons. */
export const listSessionForkCheckpointAssessments = (
	records: readonly SessionRecord[]
): SessionForkCheckpointAssessment[] =>
	records.flatMap((record) => {
		const message = record.messages[0];
		if (message === undefined) {
			return [];
		}
		const kind = checkpointKind(record);
		const assessment = assessSessionForkCheckpoint(records, record.id);
		return [
			{
				kind,
				messageId: message.id,
				recordId: record.id,
				status: assessment.kind,
				...(assessment.kind === "invalid" ? { reason: assessment.reason } : {}),
			},
		];
	});
