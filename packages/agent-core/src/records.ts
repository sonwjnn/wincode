import { type ModelUsage, modelUsageSchema } from "@wincode/ai/model-usage";
import type { ModelVariant } from "@wincode/ai/models";
import type { SkillActivationSource } from "@wincode/skills";
import type { OperationalFailure } from "./failures";
import type {
	AgentTurnDelegation,
	AgentTurnId,
	AgentTurnInterruptionReason,
	AgentTurnTextPart,
} from "./turn";
import { isAgentTurnTextPart } from "./turn";

export const CONVERSATION_RECORD_VERSION = 1 as const;

/** Durable outcome of one committed Tool Call. */
export type ToolCallOutcomeRecord =
	| {
			readonly kind: "success";
			readonly output: unknown;
	  }
	| {
			readonly errorText: string;
			readonly kind: "failure";
	  };

/**
 * One committed Tool Call part of an assistant message: the request input,
 * the settled outcome, and the Agent Turn event sequence of the outcome so
 * consumers can order durable content against the transient event stream.
 */
export type ConversationToolCallPart = {
	readonly input: unknown;
	readonly outcome: ToolCallOutcomeRecord;
	readonly sequence: number;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly type: "tool-call";
};

/** A durable reference to an externalized conversation attachment. */
export type ConversationAttachmentReferencePart = {
	readonly attachmentId: string;
	readonly available?: boolean;
	readonly byteLength: number;
	readonly filename: string;
	readonly height?: number;
	readonly mediaType: string;
	readonly type: "attachment-reference";
	readonly width?: number;
};

/** A structured file mention retained without its transient UI payload type. */
export type ConversationFileMentionPart = {
	readonly data: {
		readonly byteLength: number;
		readonly content: string;
		readonly error?: string;
		readonly kind: "directory" | "file";
		readonly path: string;
		readonly truncated: boolean;
	};
	readonly id?: string;
	readonly type: "file-mention";
};

/** Sanitized Skill activation metadata retained in a Conversation Record. */
export type ConversationSkillActivationRecord = {
	readonly arguments?: string;
	readonly contentHash: string;
	readonly name: string;
	readonly source: SkillActivationSource;
};

/** Per-message metadata safe to retain outside a transient Model Target. */
export type ConversationMessageMetadataRecord = {
	readonly agent?: string;
	readonly model?: {
		readonly modelId: string;
		readonly providerId: string;
	};
	readonly responseTimeMs?: number;
	readonly skill?: ConversationSkillActivationRecord;
	readonly sourceUserMessageId?: string;
	readonly usage?: ModelUsage;
	readonly variant?: ModelVariant;
};

export type ConversationMessagePart =
	| AgentTurnTextPart
	| ConversationAttachmentReferencePart
	| ConversationFileMentionPart
	| ConversationToolCallPart;

/**
 * Wincode-owned durable Conversation content. AI SDK part shapes never
 * appear here; attachments and file mentions retain bounded references/data
 * owned by the application.
 */
export type ConversationMessageRecord = {
	readonly id: string;
	readonly metadata?: ConversationMessageMetadataRecord;
	readonly parts: readonly ConversationMessagePart[];
	readonly role: "assistant" | "user";
};

/**
 * Durable semantic outcome of one Agent Turn. Every non-completed outcome
 * carries a safe Operational Failure ticket; interruption records why the
 * execution stopped without pretending a provider stream can be resumed.
 */
export type AgentTurnOutcomeRecord =
	| {
			readonly finishedAt: number;
			readonly kind: "completed";
			readonly usage?: ModelUsage;
	  }
	| {
			readonly failure: OperationalFailure;
			readonly finishedAt: number;
			readonly kind: "failed";
	  }
	| {
			readonly failure: OperationalFailure;
			readonly finishedAt: number;
			readonly kind: "cancelled";
	  }
	| {
			readonly failure: OperationalFailure;
			readonly finishedAt: number;
			readonly kind: "interrupted";
			readonly reason: AgentTurnInterruptionReason;
	  };

/**
 * Durable meaning of one Conversation Record row. User and Tool rows are
 * ordinary content checkpoints; assistant rows also carry the terminal Agent
 * Turn outcome that produced the assistant content.
 */
export type ConversationRecordOutcome =
	| {
			readonly kind: "user";
	  }
	| {
			readonly kind: "tool";
	  }
	| {
			readonly kind: "assistant";
			readonly terminal: AgentTurnOutcomeRecord;
	  };

/**
 * One durable Conversation Record row. Each row contains one logical user,
 * assistant, or completed Tool Call message. The runtime Agent Turn identity
 * is only meaningful while execution is live; retries do not mutate this row.
 */
export type ConversationRecord = {
	readonly agentId: string;
	readonly delegation?: AgentTurnDelegation;
	readonly id: string;
	readonly messages: readonly ConversationMessageRecord[];
	readonly model: {
		readonly modelId: string;
		readonly providerId: string;
		readonly variant?: ModelVariant;
	};
	readonly outcome: ConversationRecordOutcome;
	readonly turnId: AgentTurnId;
	readonly version: typeof CONVERSATION_RECORD_VERSION;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
	isNonNegativeInteger(value) && value > 0;

const isConversationSkillActivationRecord = (
	value: unknown
): value is ConversationSkillActivationRecord => {
	if (!isObjectRecord(value)) {
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

const isConversationMessageMetadataRecord = (
	value: unknown
): value is ConversationMessageMetadataRecord => {
	if (!isObjectRecord(value)) {
		return false;
	}
	const modelMetadata = value.model;
	const validModelMetadata =
		modelMetadata === undefined ||
		(isObjectRecord(modelMetadata) &&
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
		(value.agent === undefined ||
			(typeof value.agent === "string" && value.agent.length > 0)) &&
		validModelMetadata &&
		(value.responseTimeMs === undefined ||
			isNonNegativeInteger(value.responseTimeMs)) &&
		(value.skill === undefined ||
			isConversationSkillActivationRecord(value.skill)) &&
		(value.sourceUserMessageId === undefined ||
			(typeof value.sourceUserMessageId === "string" &&
				value.sourceUserMessageId.length > 0)) &&
		(value.usage === undefined ||
			modelUsageSchema.safeParse(value.usage).success) &&
		(value.variant === undefined || typeof value.variant === "string")
	);
};
export const isConversationAttachmentReferencePart = (
	value: unknown
): value is ConversationAttachmentReferencePart => {
	if (!isObjectRecord(value)) {
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
export const isConversationFileMentionPart = (
	value: unknown
): value is ConversationFileMentionPart => {
	if (!(isObjectRecord(value) && isObjectRecord(value.data))) {
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

export const isConversationToolCallPart = (
	value: unknown
): value is ConversationToolCallPart => {
	if (!(isObjectRecord(value) && isObjectRecord(value.outcome))) {
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

const isConversationMessagePart = (
	value: unknown
): value is ConversationMessagePart =>
	isAgentTurnTextPart(value) ||
	isConversationAttachmentReferencePart(value) ||
	isConversationFileMentionPart(value) ||
	isConversationToolCallPart(value);

export const isAgentTurnMessageRecord = (
	record: unknown
): record is ConversationMessageRecord => {
	if (!isObjectRecord(record)) {
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
		record.parts.every(isConversationMessagePart) &&
		(record.metadata === undefined ||
			isConversationMessageMetadataRecord(record.metadata))
	);
};
