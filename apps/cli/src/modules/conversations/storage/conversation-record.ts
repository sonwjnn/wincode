import {
	CONVERSATION_RECORD_VERSION,
	isAgentTurnMessageRecord,
	isAgentTurnTextPart,
	OPERATIONAL_FAILURE_VERSION,
	operationalFailureCodes,
	operationalFailureRetryDispositions,
	operationalFailureSources,
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

const isUsage = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const usage = value as { inputTokens?: unknown; outputTokens?: unknown };
	return (
		isNonNegativeInteger(usage.inputTokens) &&
		isNonNegativeInteger(usage.outputTokens)
	);
};

const isFailure = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const failure = value as Record<string, unknown>;
	if (
		!(operationalFailureCodes as readonly string[]).includes(
			String(failure.code)
		)
	) {
		return false;
	}
	if (
		!(operationalFailureSources as readonly string[]).includes(
			String(failure.source)
		)
	) {
		return false;
	}
	if (
		!(operationalFailureRetryDispositions as readonly string[]).includes(
			String(failure.retry)
		)
	) {
		return false;
	}
	if (typeof failure.message !== "string") {
		return false;
	}
	return failure.version === OPERATIONAL_FAILURE_VERSION;
};

const isOutcome = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const outcome = value as {
		finishedAt?: unknown;
		failure?: unknown;
		kind?: unknown;
		usage?: unknown;
	};
	if (typeof outcome.finishedAt !== "number") {
		return false;
	}
	if (outcome.kind === "completed") {
		return outcome.usage === undefined || isUsage(outcome.usage);
	}
	if (outcome.kind === "failed") {
		return isFailure(outcome.failure);
	}
	return false;
};

const isMessageRecord = (value: unknown): boolean => {
	if (!isAgentTurnMessageRecord(value)) {
		return false;
	}
	return Array.isArray(value.parts) && value.parts.every(isAgentTurnTextPart);
};

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
		return "record messages must contain committed text message records";
	}
	return null;
};
