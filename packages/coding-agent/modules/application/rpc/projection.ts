import type {
	SessionHost,
	SessionQueuedSubmission,
	SessionSnapshot,
	SessionSteeringMessage,
	SessionWaitingMessage,
} from "../../../modules/sessions/host/session-rpc";
import { AGENT_EVENT_TYPES, SESSION_TOOL_PART_TYPES } from "./types";
import { asRecord, safeJson, selectionWire } from "./validation";

const projectFilePart = (
	part: Record<string, unknown>
): Record<string, unknown> => ({
	type: "file",
	...(typeof part.attachmentId === "string"
		? { attachmentId: part.attachmentId }
		: {}),
	...(typeof part.filename === "string" ? { filename: part.filename } : {}),
	...(typeof part.mediaType === "string" ? { mediaType: part.mediaType } : {}),
	...(typeof part.byteLength === "number"
		? { byteLength: part.byteLength }
		: {}),
	...(typeof part.available === "boolean" ? { available: part.available } : {}),
});

const projectSourcePart = (
	record: Record<string, unknown>
): Record<string, unknown> => {
	const projected: Record<string, unknown> = { type: record.type };
	for (const key of [
		"id",
		"sourceId",
		"title",
		"url",
		"mediaType",
		"filename",
		"snippet",
	]) {
		const value = record[key];
		if (
			typeof value === "string" &&
			!(key === "url" && value.startsWith("data:"))
		) {
			projected[key] = value;
		}
	}
	return projected;
};

const projectMessagePart = (part: unknown): unknown[] => {
	const record = asRecord(part);
	if (record === undefined || typeof record.type !== "string") {
		throw new Error("Session transcript contains an invalid message part.");
	}
	if (
		(record.type === "text" || record.type === "reasoning") &&
		typeof record.text === "string"
	) {
		return [{ type: record.type, text: record.text }];
	}
	if (record.type === "file") {
		return [projectFilePart(record)];
	}
	if (
		SESSION_TOOL_PART_TYPES.has(record.type) ||
		record.type === "dynamic-tool"
	) {
		return [
			safeJson({
				errorText: record.errorText,
				failure: record.failure,
				input: record.input,
				output: record.output,
				state: record.state,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				type: record.type,
			}),
		];
	}
	if (record.type === "step-start") {
		return [{ type: "step-start" }];
	}
	if (record.type === "source-document" || record.type === "source-url") {
		return [projectSourcePart(record)];
	}
	if (record.type === "data-fileMention") {
		const data = asRecord(record.data);
		return [
			{
				type: record.type,
				...(typeof record.id === "string" ? { id: record.id } : {}),
				...(data === undefined
					? {}
					: {
							data: safeJson({
								byteLength: data.byteLength,
								error: data.error,
								kind: data.kind,
								truncated: data.truncated,
							}),
						}),
			},
		];
	}
	throw new Error(`Unknown Session message part type: ${record.type}`);
};

export const projectMessage = (message: unknown): unknown => {
	const record = asRecord(message);
	if (record === undefined) {
		throw new Error("Session transcript contains an invalid message.");
	}
	const parts = Array.isArray(record.parts)
		? record.parts.flatMap(projectMessagePart)
		: (() => {
				throw new Error("Session transcript contains invalid parts.");
			})();
	const metadata = asRecord(record.metadata);
	return {
		id: record.id,
		metadata:
			metadata === undefined
				? undefined
				: safeJson({
						agentId: metadata.agent,
						model: metadata.model,
						responseTimeMs: metadata.responseTimeMs,
						sourceUserMessageId: metadata.sourceUserMessageId,
						terminalOutcome: metadata.terminalOutcome,
						turnId: metadata.joinedTurnId,
						usage: metadata.usage,
						variant: metadata.variant,
					}),
		parts,
		role: record.role,
	};
};

const requiredEventString = (
	event: Record<string, unknown>,
	key: string
): string => {
	const value = event[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Agent event field ${key} is invalid.`);
	}
	return value;
};

const requiredEventNumber = (
	event: Record<string, unknown>,
	key: string
): number => {
	const value = event[key];
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		(key === "sequence" && !Number.isInteger(value))
	) {
		throw new Error(`Agent event field ${key} is invalid.`);
	}
	return value;
};
const projectAgentUsage = (value: unknown): unknown => {
	const usage = asRecord(value);
	const allowedKeys = new Set([
		"cacheReadTokens",
		"cacheWriteTokens",
		"inputTokens",
		"outputTokens",
		"reasoningTokens",
		"totalTokens",
	]);
	if (
		usage === undefined ||
		Object.keys(usage).some((key) => !allowedKeys.has(key)) ||
		typeof usage.inputTokens !== "number" ||
		!Number.isInteger(usage.inputTokens) ||
		usage.inputTokens < 0 ||
		typeof usage.outputTokens !== "number" ||
		!Number.isInteger(usage.outputTokens) ||
		usage.outputTokens < 0
	) {
		throw new Error("Agent event usage is invalid.");
	}
	for (const key of allowedKeys) {
		const counter = usage?.[key];
		if (
			counter !== undefined &&
			(typeof counter !== "number" || !Number.isInteger(counter) || counter < 0)
		) {
			throw new Error("Agent event usage is invalid.");
		}
	}
	return safeJson(usage);
};

const projectAgentDelegation = (value: unknown): unknown => {
	const delegation = asRecord(value);
	if (
		delegation === undefined ||
		Object.keys(delegation).length !== 2 ||
		typeof delegation.parentTurnId !== "string" ||
		delegation.parentTurnId.length === 0 ||
		typeof delegation.parentToolCallId !== "string" ||
		delegation.parentToolCallId.length === 0
	) {
		throw new Error("Agent event delegation is invalid.");
	}
	return safeJson(delegation);
};

const projectToolFailureDetails = (value: unknown): unknown => {
	const failure = asRecord(value);
	if (
		failure === undefined ||
		typeof failure.code !== "string" ||
		failure.code.length === 0 ||
		Object.keys(failure).some(
			(key) => !["code", "details", "recovery"].includes(key)
		)
	) {
		throw new Error("Agent tool failure details are invalid.");
	}
	return safeJson(failure);
};

const projectToolOutcome = (value: unknown): unknown => {
	const outcome = asRecord(value);
	if (outcome === undefined || typeof outcome.type !== "string") {
		throw new Error("Agent tool outcome is invalid.");
	}
	if (outcome.type === "success") {
		if (
			Object.keys(outcome).some((key) => !["output", "type"].includes(key)) ||
			!("output" in outcome)
		) {
			throw new Error("Agent tool success is invalid.");
		}
		return safeJson(outcome);
	}
	if (outcome.type === "failure") {
		if (
			typeof outcome.errorText !== "string" ||
			outcome.errorText.length === 0 ||
			Object.keys(outcome).some(
				(key) => !["errorText", "failure", "type"].includes(key)
			)
		) {
			throw new Error("Agent tool failure is invalid.");
		}
		if (outcome.failure !== undefined) {
			projectToolFailureDetails(outcome.failure);
		}
		return safeJson(outcome);
	}
	throw new Error("Agent tool outcome is invalid.");
};

const projectOperationalFailure = (value: unknown): unknown => {
	const failure = asRecord(value);
	const codes = new Set([
		"authentication",
		"authorization",
		"cancelled",
		"context-overflow",
		"deadline-exceeded",
		"interrupted",
		"invalid-request",
		"network",
		"rate-limited",
		"unavailable",
		"unknown",
	]);
	const retries = new Set([
		"never",
		"immediate",
		"after-delay",
		"with-changes",
	]);
	const sources = new Set(["model", "runtime"]);
	const allowedKeys = new Set([
		"code",
		"details",
		"message",
		"retry",
		"source",
		"version",
	]);
	if (
		failure === undefined ||
		Object.keys(failure).some((key) => !allowedKeys.has(key)) ||
		!codes.has(String(failure.code)) ||
		typeof failure.message !== "string" ||
		failure.message.length === 0 ||
		!retries.has(String(failure.retry)) ||
		!sources.has(String(failure.source)) ||
		failure.version !== 1
	) {
		throw new Error("Agent operational failure is invalid.");
	}
	const details = failure.details;
	if (details !== undefined) {
		const detailRecord = asRecord(details);
		if (
			detailRecord === undefined ||
			Object.keys(detailRecord).some(
				(key) =>
					!["modelId", "providerId", "retryAfterMs", "statusCode"].includes(key)
			) ||
			(detailRecord.modelId !== undefined &&
				(typeof detailRecord.modelId !== "string" ||
					detailRecord.modelId.length === 0)) ||
			(detailRecord.providerId !== undefined &&
				(typeof detailRecord.providerId !== "string" ||
					detailRecord.providerId.length === 0)) ||
			(detailRecord.retryAfterMs !== undefined &&
				(typeof detailRecord.retryAfterMs !== "number" ||
					!Number.isInteger(detailRecord.retryAfterMs) ||
					detailRecord.retryAfterMs <= 0)) ||
			(detailRecord.statusCode !== undefined &&
				(typeof detailRecord.statusCode !== "number" ||
					!Number.isInteger(detailRecord.statusCode) ||
					detailRecord.statusCode < 100 ||
					detailRecord.statusCode > 599))
		) {
			throw new Error("Agent operational failure details are invalid.");
		}
	}
	return safeJson(failure);
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This projector preserves every Agent event discriminant and payload explicitly.
export const projectAgentEvent = (value: unknown): Record<string, unknown> => {
	const event = asRecord(value);
	if (
		event === undefined ||
		typeof event.type !== "string" ||
		!AGENT_EVENT_TYPES.has(event.type)
	) {
		throw new Error("Unknown Agent Turn event discriminant.");
	}
	const base = {
		sequence: requiredEventNumber(event, "sequence"),
		turnId: requiredEventString(event, "turnId"),
		type: event.type,
	};
	switch (event.type) {
		case "agent-turn-started":
			return {
				...base,
				agentId: requiredEventString(event, "agentId"),
				...(event.delegation === undefined
					? {}
					: { delegation: projectAgentDelegation(event.delegation) }),
				startedAt: requiredEventNumber(event, "startedAt"),
			};
		case "model-step-started":
			return {
				...base,
				...(event.modelId === undefined
					? {}
					: { modelId: requiredEventString(event, "modelId") }),
				stepId: requiredEventString(event, "stepId"),
			};
		case "text-delta":
		case "reasoning-delta":
			return { ...base, delta: requiredEventString(event, "delta") };
		case "model-step-finished":
			return {
				...base,
				...(event.modelId === undefined
					? {}
					: { modelId: requiredEventString(event, "modelId") }),
				stepId: requiredEventString(event, "stepId"),
				...(event.usage === undefined
					? {}
					: { usage: projectAgentUsage(event.usage) }),
			};
		case "tool-call-started":
			if (!("input" in event)) {
				throw new Error("Agent tool-start event input is missing.");
			}
			return {
				...base,
				input: safeJson(event.input),
				toolCallId: requiredEventString(event, "toolCallId"),
				toolName: requiredEventString(event, "toolName"),
			};
		case "tool-call-finished":
			if (!("outcome" in event)) {
				throw new Error("Agent tool-finished event outcome is missing.");
			}
			return {
				...base,
				outcome: projectToolOutcome(event.outcome),
				toolCallId: requiredEventString(event, "toolCallId"),
				toolName: requiredEventString(event, "toolName"),
			};
		case "agent-turn-completed":
			return {
				...base,
				finishedAt: requiredEventNumber(event, "finishedAt"),
				...(event.usage === undefined
					? {}
					: { usage: projectAgentUsage(event.usage) }),
			};
		case "agent-turn-failed":
		case "agent-turn-cancelled":
		case "agent-turn-interrupted":
			if (!("failure" in event)) {
				throw new Error("Agent terminal event failure is missing.");
			}
			return {
				...base,
				failure: projectOperationalFailure(event.failure),
				finishedAt: requiredEventNumber(event, "finishedAt"),
				...(event.reason === undefined
					? {}
					: { reason: requiredEventString(event, "reason") }),
			};
		default:
			throw new Error("Unknown Agent Turn event discriminant.");
	}
};

export const projectSubmissionEvent = (
	value: unknown
): Record<string, unknown> => {
	const event = asRecord(value);
	if (
		event === undefined ||
		typeof event.kind !== "string" ||
		!["started", "delivered", "recalled", "failed"].includes(event.kind)
	) {
		throw new Error("Unknown Submission event discriminant.");
	}
	const reason =
		event.reason === undefined
			? {}
			: { reason: requiredEventString(event, "reason") };
	return {
		kind: event.kind,
		messageId: requiredEventString(event, "messageId"),
		submissionId: requiredEventString(event, "submissionId"),
		...reason,
		...(event.turnId === undefined
			? {}
			: { turnId: requiredEventString(event, "turnId") }),
	};
};

export const selectionFromHost = (host: SessionHost): unknown => {
	const selection = host.getSelection();
	if (selection === null || selection.agent === undefined) {
		return null;
	}
	return {
		agentId: selection.agent,
		model: selection.model,
		...(selection.variant === undefined ? {} : { variant: selection.variant }),
	};
};

export const submissionFromWaiting = (
	message: SessionWaitingMessage
): Record<string, unknown> => {
	if ("messageId" in message) {
		const queued: SessionQueuedSubmission = message;
		const input = queued.input;
		return {
			messageId: queued.messageId,
			selection: {
				agentId: input.agent,
				model: input.model,
				...(input.variant === undefined ? {} : { variant: input.variant }),
			},
			submissionId: queued.submissionId,
			disposition: "queued",
			text: input.composition.text,
			...(input.turnId === undefined ? {} : { turnId: input.turnId }),
		};
	}
	const steering: SessionSteeringMessage = message;
	const input = steering.input;
	return {
		messageId: input.messageId,
		selection: {
			agentId: input.agent,
			model: input.model,
			...(input.variant === undefined ? {} : { variant: input.variant }),
		},
		submissionId: input.submissionId,
		disposition: "steering",
		text: input.text,
		...(input.turnId === undefined ? {} : { turnId: input.turnId }),
	};
};
export const projectExecution = (
	execution: SessionSnapshot["executions"][number]
): Record<string, unknown> => ({
	agentId: execution.agent,
	model: execution.model,
	sourceUserMessageId: execution.sourceUserMessageId,
	startedAt: execution.startedAt,
	submissionId: execution.submissionId,
	turnId: execution.turnId,
	variant: execution.variant,
});

export const projectApproval = (
	approval: SessionSnapshot["approvals"][number],
	wireApprovalId: string
): Record<string, unknown> => ({
	approvalId: wireApprovalId,
	description: approval.request.description,
	identity: safeJson(approval.request.identity),
	input: safeJson(approval.request.input),
	safety: approval.request.safety === true,
	target: approval.target,
	...(approval.request.toolCallId === undefined
		? {}
		: { toolCallId: approval.request.toolCallId }),
});

export const projectSteering = (
	message: SessionSnapshot["steeringMessages"][number]
): Record<string, unknown> => ({
	messageId: message.input.messageId,
	selection: selectionWire({
		agentId: message.input.agent,
		model: message.input.model,
		...(message.input.variant === undefined
			? {}
			: { variant: message.input.variant }),
	}),
	submissionId: message.input.submissionId,
	text: message.input.text,
	...(message.input.turnId === undefined
		? {}
		: { turnId: message.input.turnId }),
});

export const projectQueued = (
	submission: SessionSnapshot["queuedSubmissions"][number]
): Record<string, unknown> => ({
	messageId: submission.messageId,
	selection: selectionWire({
		agentId: submission.input.agent,
		model: submission.input.model,
		...(submission.input.variant === undefined
			? {}
			: { variant: submission.input.variant }),
	}),
	submissionId: submission.submissionId,
	text: submission.input.userText ?? submission.input.composition?.text ?? "",
	...(submission.input.turnId === undefined
		? {}
		: { turnId: submission.input.turnId }),
});

export const operationalStatus = (input: {
	approvals: number;
	compacting: boolean;
	turnActive: boolean;
	waiting: boolean;
}): string => {
	if (input.compacting) {
		return "compacting";
	}
	if (input.turnActive) {
		return "running";
	}
	if (input.approvals > 0) {
		return "waiting";
	}
	if (input.waiting) {
		return "queued";
	}
	return "idle";
};
