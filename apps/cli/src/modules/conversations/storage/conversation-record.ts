import type { OperationalFailure } from "@wincode/agent-core";
import {
	AGENT_TURN_INTERRUPTION_REASONS,
	AgentInvariantError,
	CONVERSATION_RECORD_VERSION,
	isAgentTurnDelegation,
	isAgentTurnMessageRecord,
	isAgentTurnTextPart,
	isOperationalFailure,
} from "@wincode/agent-core";

const hasText = (value: unknown): boolean =>
	typeof value === "string" && value.length > 0;

const isRecordModel = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const model = value as { modelId?: unknown; providerId?: unknown };
	if (!hasText(model.modelId)) {
		return false;
	}
	return hasText(model.providerId);
};

const isNonNegativeInteger = (value: unknown): boolean => {
	if (typeof value !== "number") {
		return false;
	}
	return Number.isInteger(value) && value >= 0;
};

const isFiniteTimestamp = (value: unknown): boolean =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const isOptionalNonNegativeInteger = (value: unknown): boolean =>
	value === undefined || isNonNegativeInteger(value);

const isUsage = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const usage = value as Record<string, unknown>;
	if (
		Object.keys(usage).some(
			(key) =>
				![
					"cacheReadTokens",
					"cacheWriteTokens",
					"inputTokens",
					"outputTokens",
					"reasoningTokens",
					"totalTokens",
				].includes(key)
		)
	) {
		return false;
	}
	return (
		isNonNegativeInteger(usage.inputTokens) &&
		isNonNegativeInteger(usage.outputTokens) &&
		isOptionalNonNegativeInteger(usage.cacheReadTokens) &&
		isOptionalNonNegativeInteger(usage.cacheWriteTokens) &&
		isOptionalNonNegativeInteger(usage.reasoningTokens) &&
		isOptionalNonNegativeInteger(usage.totalTokens)
	);
};

const isFailure = (value: unknown): value is OperationalFailure =>
	isOperationalFailure(value);

const isOutcome = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const outcome = value as {
		finishedAt?: unknown;
		failure?: unknown;
		kind?: unknown;
		reason?: unknown;
		usage?: unknown;
	};
	if (!isFiniteTimestamp(outcome.finishedAt)) {
		return false;
	}
	if (outcome.kind === "completed") {
		return outcome.usage === undefined || isUsage(outcome.usage);
	}
	if (outcome.kind === "failed") {
		return isFailure(outcome.failure);
	}
	if (outcome.kind === "cancelled") {
		return isFailure(outcome.failure) && outcome.failure.code === "cancelled";
	}
	if (outcome.kind === "interrupted") {
		return (
			isFailure(outcome.failure) &&
			outcome.failure.code === "interrupted" &&
			(AGENT_TURN_INTERRUPTION_REASONS as readonly string[]).includes(
				String(outcome.reason)
			)
		);
	}
	return false;
};

const isToolCallOutcomeRecord = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const outcome = value as Record<string, unknown>;
	if (outcome.kind === "success") {
		return (
			Object.keys(outcome).every((key) => key === "kind" || key === "output") &&
			"output" in outcome
		);
	}
	if (outcome.kind === "failure") {
		return (
			Object.keys(outcome).every(
				(key) => key === "errorText" || key === "kind"
			) &&
			typeof outcome.errorText === "string" &&
			outcome.errorText.length > 0
		);
	}
	return false;
};

const isConversationToolCallPart = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const part = value as Record<string, unknown>;
	if (
		Object.keys(part).some(
			(key) =>
				![
					"input",
					"outcome",
					"sequence",
					"toolCallId",
					"toolName",
					"type",
				].includes(key)
		)
	) {
		return false;
	}
	return (
		part.type === "tool-call" &&
		typeof part.toolCallId === "string" &&
		part.toolCallId.length > 0 &&
		typeof part.toolName === "string" &&
		part.toolName.length > 0 &&
		"input" in part &&
		isNonNegativeInteger(part.sequence) &&
		isToolCallOutcomeRecord(part.outcome)
	);
};

const isMessagePart = (value: unknown): boolean =>
	isAgentTurnTextPart(value) || isConversationToolCallPart(value);

const isMessageRecord = (value: unknown): boolean => {
	if (!isAgentTurnMessageRecord(value)) {
		return false;
	}
	return Array.isArray(value.parts) && value.parts.every(isMessagePart);
};
export class ConversationRecordInvariantError extends AgentInvariantError {
	override readonly code = "invalid-record" as const;

	constructor(message: string, options?: ErrorOptions) {
		super("invalid-record", message, options);
		this.name = "ConversationRecordInvariantError";
	}
}

/**
 * Validates one Wincode Conversation Record before it is committed. Returns a
 * stable description of the first violation, or `null` when the record is a
 * safe durable unit. Raw provider material never reaches this shape, so no
 * redaction happens here.
 */
export const getConversationRecordValidationError = (
	value: unknown
): string | null => {
	if (typeof value !== "object" || value === null) {
		return "record must be an object";
	}
	const record = value as Record<string, unknown>;
	if (record.version !== CONVERSATION_RECORD_VERSION) {
		return `unsupported record version ${String(record.version)}`;
	}
	if (!hasText(record.id)) {
		return "record id must be a non-empty string";
	}
	if (!hasText(record.turnId)) {
		return "record turn id must be a non-empty string";
	}
	if (!hasText(record.agentId)) {
		return "record agent id must be a non-empty string";
	}
	if (
		record.delegation !== undefined &&
		!isAgentTurnDelegation(record.delegation)
	) {
		return "record delegation correlation is invalid";
	}
	if (!isRecordModel(record.model)) {
		return "record model must name a provider and model id";
	}
	if (!isOutcome(record.outcome)) {
		return "record outcome is not a valid terminal outcome";
	}
	if (
		!Array.isArray(record.messages) ||
		record.messages.length === 0 ||
		!record.messages.every(isMessageRecord)
	) {
		return "record messages must contain committed text or Tool Call parts";
	}
	return null;
};
