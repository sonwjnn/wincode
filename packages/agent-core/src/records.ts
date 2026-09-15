import { type ModelUsage, modelUsageSchema } from "@wincode/ai/model-usage";
import type { ModelId, ModelVariant } from "@wincode/ai/models";
import {
	isNonNegativeInteger,
	isPlainObject,
	isPositiveInteger,
} from "@wincode/runtime-utils";
import type { SkillActivationSource } from "@wincode/skills";
import type { ReadonlyDeep } from "type-fest";
import { isAgentId } from "./agent";
import type { OperationalFailure } from "./failures";
import type {
	AgentId,
	AttachmentId,
	SessionMessageId,
	SessionRecordId,
	ToolCallId,
} from "./identifiers";
import type {
	AgentTurnDelegation,
	AgentTurnId,
	AgentTurnInterruptionReason,
	AgentTurnTextPart,
} from "./turn";
import { isAgentTurnTextPart } from "./turn";

export const SESSION_RECORD_VERSION = 1 as const;

/** Durable outcome of one committed Tool Call. */
export type ToolCallOutcomeRecord = ReadonlyDeep<
	| {
			kind: "success";
			output: unknown;
	  }
	| {
			errorText: string;
			kind: "failure";
	  }
>;

/**
 * One committed Tool Call part of an assistant message: the request input,
 * the settled outcome, and the Agent Turn event sequence of the outcome so
 * consumers can order durable content against the transient event stream.
 */
export type SessionToolCallPart = ReadonlyDeep<{
	input: unknown;
	outcome: ToolCallOutcomeRecord;
	sequence: number;
	toolCallId: ToolCallId;
	toolName: string;
	type: "tool-call";
}>;

/** A durable reference to an externalized session attachment. */
export type SessionAttachmentReferencePart = ReadonlyDeep<{
	attachmentId: AttachmentId;
	available?: boolean;
	byteLength: number;
	filename: string;
	height?: number;
	mediaType: string;
	type: "attachment-reference";
	width?: number;
}>;

/** A structured file mention retained without its transient UI payload type. */
export type SessionFileMentionPart = ReadonlyDeep<{
	data: {
		byteLength: number;
		content: string;
		error?: string;
		kind: "directory" | "file";
		path: string;
		truncated: boolean;
	};
	id?: string;
	type: "file-mention";
}>;

/** Sanitized Skill activation metadata retained in a Session Record. */
export type SessionSkillActivationRecord = ReadonlyDeep<{
	arguments?: string;
	contentHash: string;
	name: string;
	source: SkillActivationSource;
}>;

/** Per-message metadata safe to retain outside a transient Model Target. */
export type SessionMessageMetadataRecord = ReadonlyDeep<{
	agent?: AgentId;
	model?: {
		modelId: ModelId;
		providerId: string;
	};
	responseTimeMs?: number;
	skill?: SessionSkillActivationRecord;
	sourceUserMessageId?: SessionMessageId;
	usage?: ModelUsage;
	variant?: ModelVariant;
}>;

export type SessionMessagePart =
	| AgentTurnTextPart
	| SessionAttachmentReferencePart
	| SessionFileMentionPart
	| SessionToolCallPart;

/**
 * Wincode-owned durable Session content. AI SDK part shapes never
 * appear here; attachments and file mentions retain bounded references/data
 * owned by the application.
 */
export type SessionMessageRecord = ReadonlyDeep<{
	id: SessionMessageId;
	metadata?: SessionMessageMetadataRecord;
	parts: SessionMessagePart[];
	role: "assistant" | "user";
}>;

/**
 * Durable semantic outcome of one Agent Turn. Every non-completed outcome
 * carries a safe Operational Failure ticket; interruption records why the
 * execution stopped without pretending a provider stream can be resumed.
 */
export type AgentTurnOutcomeRecord = ReadonlyDeep<
	| {
			finishedAt: number;
			kind: "completed";
			usage?: ModelUsage;
	  }
	| {
			failure: OperationalFailure;
			finishedAt: number;
			kind: "failed";
	  }
	| {
			failure: OperationalFailure;
			finishedAt: number;
			kind: "cancelled";
	  }
	| {
			failure: OperationalFailure;
			finishedAt: number;
			kind: "interrupted";
			reason: AgentTurnInterruptionReason;
	  }
>;

/**
 * Durable meaning of one Session Record row. User and Tool rows are
 * ordinary content checkpoints; assistant rows also carry the terminal Agent
 * Turn outcome that produced the assistant content.
 */
export type SessionRecordOutcome = ReadonlyDeep<
	| {
			kind: "user";
	  }
	| {
			kind: "tool";
	  }
	| {
			kind: "assistant";
			terminal: AgentTurnOutcomeRecord;
	  }
>;

/**
 * One durable Session Record row. Each row contains one logical user,
 * assistant, or completed Tool Call message. The runtime Agent Turn identity
 * is only meaningful while execution is live; retries do not mutate this row.
 */
export type SessionRecord = ReadonlyDeep<{
	agentId: AgentId;
	delegation?: AgentTurnDelegation;
	id: SessionRecordId;
	messages: SessionMessageRecord[];
	model: {
		modelId: ModelId;
		providerId: string;
		variant?: ModelVariant;
	};
	outcome: SessionRecordOutcome;
	turnId: AgentTurnId;
	version: typeof SESSION_RECORD_VERSION;
}>;

const isSessionSkillActivationRecord = (
	value: unknown
): value is SessionSkillActivationRecord => {
	if (!isPlainObject(value)) {
		return false;
	}
	return (
		Object.keys(value).every(
			(key) =>
				key === "arguments" ||
				key === "contentHash" ||
				key === "name" ||
				key === "source"
		) &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		typeof value.contentHash === "string" &&
		value.contentHash.length > 0 &&
		(value.source === "agent" || value.source === "explicit") &&
		(value.arguments === undefined || typeof value.arguments === "string")
	);
};

const isSessionMessageMetadataRecord = (
	value: unknown
): value is SessionMessageMetadataRecord => {
	if (!isPlainObject(value)) {
		return false;
	}
	const modelMetadata = value.model;
	const validModelMetadata =
		modelMetadata === undefined ||
		(isPlainObject(modelMetadata) &&
			Object.keys(modelMetadata).every(
				(key) => key === "modelId" || key === "providerId"
			) &&
			typeof modelMetadata.modelId === "string" &&
			modelMetadata.modelId.length > 0 &&
			typeof modelMetadata.providerId === "string" &&
			modelMetadata.providerId.length > 0);
	return (
		Object.keys(value).every(
			(key) =>
				key === "agent" ||
				key === "model" ||
				key === "responseTimeMs" ||
				key === "skill" ||
				key === "sourceUserMessageId" ||
				key === "usage" ||
				key === "variant"
		) &&
		(value.agent === undefined || isAgentId(value.agent)) &&
		validModelMetadata &&
		(value.responseTimeMs === undefined ||
			isNonNegativeInteger(value.responseTimeMs)) &&
		(value.skill === undefined ||
			isSessionSkillActivationRecord(value.skill)) &&
		(value.sourceUserMessageId === undefined ||
			(typeof value.sourceUserMessageId === "string" &&
				value.sourceUserMessageId.length > 0)) &&
		(value.usage === undefined ||
			modelUsageSchema.safeParse(value.usage).success) &&
		(value.variant === undefined || typeof value.variant === "string")
	);
};
export const isSessionAttachmentReferencePart = (
	value: unknown
): value is SessionAttachmentReferencePart => {
	if (!isPlainObject(value)) {
		return false;
	}
	return (
		Object.keys(value).every(
			(key) =>
				key === "attachmentId" ||
				key === "available" ||
				key === "byteLength" ||
				key === "filename" ||
				key === "height" ||
				key === "mediaType" ||
				key === "type" ||
				key === "width"
		) &&
		value.type === "attachment-reference" &&
		typeof value.attachmentId === "string" &&
		value.attachmentId.length > 0 &&
		(value.available === undefined || typeof value.available === "boolean") &&
		isNonNegativeInteger(value.byteLength) &&
		typeof value.filename === "string" &&
		value.filename.length > 0 &&
		typeof value.mediaType === "string" &&
		value.mediaType.length > 0 &&
		(value.height === undefined || isPositiveInteger(value.height)) &&
		(value.width === undefined || isPositiveInteger(value.width))
	);
};
export const isSessionFileMentionPart = (
	value: unknown
): value is SessionFileMentionPart => {
	if (!(isPlainObject(value) && isPlainObject(value.data))) {
		return false;
	}
	const mention = value.data;
	return (
		Object.keys(value).every(
			(key) => key === "data" || key === "id" || key === "type"
		) &&
		value.type === "file-mention" &&
		(value.id === undefined || typeof value.id === "string") &&
		Object.keys(mention).every(
			(key) =>
				key === "byteLength" ||
				key === "content" ||
				key === "error" ||
				key === "kind" ||
				key === "path" ||
				key === "truncated"
		) &&
		isNonNegativeInteger(mention.byteLength) &&
		typeof mention.content === "string" &&
		(mention.error === undefined || typeof mention.error === "string") &&
		(mention.kind === "file" || mention.kind === "directory") &&
		typeof mention.path === "string" &&
		mention.path.length > 0 &&
		typeof mention.truncated === "boolean"
	);
};

export const isSessionToolCallPart = (
	value: unknown
): value is SessionToolCallPart => {
	if (!(isPlainObject(value) && isPlainObject(value.outcome))) {
		return false;
	}
	const outcome = value.outcome;
	const validOutcome =
		outcome.kind === "success"
			? Object.keys(outcome).every(
					(key) => key === "kind" || key === "output"
				) && "output" in outcome
			: outcome.kind === "failure" &&
				Object.keys(outcome).every(
					(key) => key === "errorText" || key === "kind"
				) &&
				typeof outcome.errorText === "string" &&
				outcome.errorText.length > 0;
	return (
		Object.keys(value).every(
			(key) =>
				key === "input" ||
				key === "outcome" ||
				key === "sequence" ||
				key === "toolCallId" ||
				key === "toolName" ||
				key === "type"
		) &&
		value.type === "tool-call" &&
		typeof value.toolCallId === "string" &&
		value.toolCallId.length > 0 &&
		typeof value.toolName === "string" &&
		value.toolName.length > 0 &&
		isNonNegativeInteger(value.sequence) &&
		validOutcome &&
		"input" in value
	);
};

const isSessionMessagePart = (value: unknown): value is SessionMessagePart =>
	isAgentTurnTextPart(value) ||
	isSessionAttachmentReferencePart(value) ||
	isSessionFileMentionPart(value) ||
	isSessionToolCallPart(value);

export const isAgentTurnMessageRecord = (
	record: unknown
): record is SessionMessageRecord => {
	if (!isPlainObject(record)) {
		return false;
	}
	return (
		Object.keys(record).every(
			(key) =>
				key === "id" || key === "metadata" || key === "parts" || key === "role"
		) &&
		typeof record.id === "string" &&
		record.id.length > 0 &&
		(record.role === "assistant" || record.role === "user") &&
		Array.isArray(record.parts) &&
		record.parts.every(isSessionMessagePart) &&
		(record.metadata === undefined ||
			isSessionMessageMetadataRecord(record.metadata))
	);
};
