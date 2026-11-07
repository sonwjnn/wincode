import type { ModelUsage } from "@wincode/ai";
import { modelUsageSchema } from "@wincode/ai";
import {
	isFiniteNonNegativeNumber,
	isNonEmptyString,
	isNonNegativeInteger,
	isObjectLike,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import type { UnknownRecord } from "type-fest";
import { type AgentId, isAgentId } from "./agent";
import type { OperationalFailure } from "./failures";
import { isOperationalFailure } from "./failures";
import type { ModelId } from "./identifiers";
import {
	isModelStepAttemptSummary,
	isModelStepRetryEndOutcome,
	MODEL_STEP_ATTEMPT_SUMMARY_LIMIT,
	type ModelStepAttemptPartialOutput,
	type ModelStepAttemptSummary,
	type ModelStepId,
	type ModelStepRetryEndOutcome,
} from "./model-step";
import {
	isToolCallId,
	isToolCallOutput,
	type ToolCallId,
	type ToolCallOutput,
} from "./tools";
import {
	AGENT_TURN_INTERRUPTION_REASONS,
	type AgentTurnId,
	type AgentTurnInterruptionReason,
} from "./turn";

/**
 * Common shape of every Agent Turn Event: the Agent Turn identity and a
 * monotonic sequence within that turn. Sequence increases by one per emitted
 * event so consumers can order and correlate a single turn.
 */
export type AgentTurnEventBase = Readonly<{
	sequence: number;
	turnId: AgentTurnId;
}>;

/** The turn began. The first event of a run. */
export type AgentTurnStartedEvent = AgentTurnEventBase &
	Readonly<{
		agentId: AgentId;
		startedAt: number;
		type: "agent-turn-started";
	}>;

/** One model invocation within the turn started. */
export type ModelStepStartedEvent = AgentTurnEventBase &
	Readonly<{
		modelId?: ModelId;
		stepId: ModelStepId;
		type: "model-step-started";
	}>;

/** A transient retry was scheduled after a recoverable Model Step failure. */
export type ModelStepRetryScheduledEvent = AgentTurnEventBase &
	Readonly<{
		attempt: number;
		failure: OperationalFailure;
		maxAttempts: number;
		partialOutput?: ModelStepAttemptPartialOutput;
		retryAt: number;
		stepId: ModelStepId;
		type: "model-step-retry-scheduled";
		usage?: ModelUsage;
	}>;

/** One scheduled retry sequence reached a terminal recovery outcome. */
export type ModelStepRetryEndedEvent = AgentTurnEventBase &
	Readonly<{
		attempt: number;
		failure?: OperationalFailure;
		maxAttempts: number;
		outcome: ModelStepRetryEndOutcome;
		stepId: ModelStepId;
		type: "model-step-retry-ended";
	}>;

/** A streamed text delta from the current Model Step. */
export type TextDeltaEvent = AgentTurnEventBase &
	Readonly<{
		delta: string;
		type: "text-delta";
	}>;

/** A streamed reasoning delta from the current Model Step. */
export type ReasoningDeltaEvent = AgentTurnEventBase &
	Readonly<{
		delta: string;
		type: "reasoning-delta";
	}>;

/** One model invocation finished with its usage. */
export type ModelStepFinishedEvent = AgentTurnEventBase &
	Readonly<{
		modelId?: ModelId;
		stepId: ModelStepId;
		type: "model-step-finished";
		usage?: ModelUsage;
	}>;

/** The Agent requested one Tool Call with a complete input. */
export type ToolCallStartedEvent = AgentTurnEventBase &
	Readonly<{
		input: unknown;
		toolCallId: ToolCallId;
		toolName: string;
		type: "tool-call-started";
	}>;

/** One Tool Call reached its output, failure, deny, or rejection outcome. */
export type ToolCallFinishedEvent = AgentTurnEventBase &
	Readonly<{
		outcome: ToolCallOutput;
		toolCallId: ToolCallId;
		toolName: string;
		type: "tool-call-finished";
	}>;

type AgentTurnAttemptSummaryFields = Readonly<{
	modelStepAttempts?: readonly ModelStepAttemptSummary[];
	modelStepAttemptsTruncated?: true;
}>;

/** The turn reached its terminal `completed` outcome. */
export type AgentTurnCompletedEvent = AgentTurnEventBase &
	Readonly<{
		finishedAt: number;
		outputLimitReached?: true;
		type: "agent-turn-completed";
		usage?: ModelUsage;
	}> &
	AgentTurnAttemptSummaryFields;

/** The caller cancelled the turn. */
export type AgentTurnCancelledEvent = AgentTurnEventBase &
	Readonly<{
		failure: OperationalFailure;
		finishedAt: number;
		type: "agent-turn-cancelled";
		usage?: ModelUsage;
	}> &
	AgentTurnAttemptSummaryFields;

/** The turn stopped without completion, failure, or caller cancellation. */
export type AgentTurnInterruptedEvent = AgentTurnEventBase &
	Readonly<{
		failure: OperationalFailure;
		finishedAt: number;
		reason: AgentTurnInterruptionReason;
		type: "agent-turn-interrupted";
		usage?: ModelUsage;
	}> &
	AgentTurnAttemptSummaryFields;

/** The turn reached an expected operational failure. */
export type AgentTurnFailedEvent = AgentTurnEventBase &
	Readonly<{
		failure: OperationalFailure;
		finishedAt: number;
		type: "agent-turn-failed";
		usage?: ModelUsage;
	}> &
	AgentTurnAttemptSummaryFields;

export type AgentTurnTerminalEvent =
	| AgentTurnCancelledEvent
	| AgentTurnCompletedEvent
	| AgentTurnFailedEvent
	| AgentTurnInterruptedEvent;

export type AgentTurnEvent =
	| AgentTurnStartedEvent
	| ModelStepStartedEvent
	| ModelStepRetryScheduledEvent
	| ModelStepRetryEndedEvent
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ModelStepFinishedEvent
	| ToolCallStartedEvent
	| ToolCallFinishedEvent
	| AgentTurnTerminalEvent;

export const AGENT_TURN_EVENT_TYPES = [
	"agent-turn-started",
	"model-step-started",
	"model-step-retry-scheduled",
	"model-step-retry-ended",
	"text-delta",
	"reasoning-delta",
	"model-step-finished",
	"tool-call-started",
	"tool-call-finished",
	"agent-turn-completed",
	"agent-turn-failed",
	"agent-turn-cancelled",
	"agent-turn-interrupted",
] as const satisfies readonly AgentTurnEvent["type"][];

export const AGENT_TURN_EVENT_TERMINAL_TYPES = [
	"agent-turn-completed",
	"agent-turn-failed",
	"agent-turn-cancelled",
	"agent-turn-interrupted",
] as const satisfies readonly AgentTurnTerminalEvent["type"][];

const isUsage = (value: unknown): value is ModelUsage =>
	modelUsageSchema.safeParse(value).success;

const hasValidOptionalUsage = (event: UnknownRecord): boolean =>
	isUndefined(event.usage) || isUsage(event.usage);

const hasValidOptionalAttempts = (event: UnknownRecord): boolean => {
	const attempts = event.modelStepAttempts;
	const truncated = event.modelStepAttemptsTruncated;
	if (
		(truncated !== undefined && truncated !== true) ||
		(attempts !== undefined &&
			(!Array.isArray(attempts) ||
				attempts.length > MODEL_STEP_ATTEMPT_SUMMARY_LIMIT ||
				!attempts.every(isModelStepAttemptSummary)))
	) {
		return false;
	}
	return (
		truncated !== true ||
		(Array.isArray(attempts) &&
			attempts.length === MODEL_STEP_ATTEMPT_SUMMARY_LIMIT)
	);
};

const hasValidRetryAttemptSummary = (event: UnknownRecord): boolean =>
	isModelStepAttemptSummary({
		attempt: event.attempt,
		failure: event.failure,
		maxRetries: event.maxAttempts,
		...omitUndefined({ partialOutput: event.partialOutput }),
		retryDecision: "scheduled",
		stepId: event.stepId,
		...omitUndefined({ usage: event.usage }),
	});

const isModelStepRetryScheduledEvent = (event: UnknownRecord): boolean =>
	isNonNegativeInteger(event.attempt) &&
	event.attempt > 0 &&
	isNonNegativeInteger(event.maxAttempts) &&
	event.maxAttempts > 0 &&
	event.attempt <= event.maxAttempts &&
	isFiniteNonNegativeNumber(event.retryAt) &&
	isNonEmptyString(event.stepId) &&
	isOperationalFailure(event.failure) &&
	(event.failure.retry === "after-delay" ||
		event.failure.retry === "immediate") &&
	hasValidRetryAttemptSummary(event);

const isModelStepRetryEndedEvent = (event: UnknownRecord): boolean =>
	isNonNegativeInteger(event.attempt) &&
	event.attempt > 0 &&
	isNonNegativeInteger(event.maxAttempts) &&
	event.maxAttempts > 0 &&
	event.attempt <= event.maxAttempts &&
	isNonEmptyString(event.stepId) &&
	isModelStepRetryEndOutcome(event.outcome) &&
	(event.outcome === "success"
		? isUndefined(event.failure)
		: isOperationalFailure(event.failure));

const hasBaseEvent = (value: unknown): value is AgentTurnEventBase => {
	if (!isObjectLike(value)) {
		return false;
	}
	const event = value as UnknownRecord;
	return isNonEmptyString(event.turnId) && isNonNegativeInteger(event.sequence);
};

export const isAgentTurnEvent = (value: unknown): value is AgentTurnEvent => {
	if (!hasBaseEvent(value)) {
		return false;
	}
	const event = value as UnknownRecord;
	if (
		!(
			isString(event.type) &&
			(AGENT_TURN_EVENT_TYPES as readonly string[]).includes(event.type)
		)
	) {
		return false;
	}
	switch (event.type) {
		case "agent-turn-started":
			return (
				isAgentId(event.agentId) && isFiniteNonNegativeNumber(event.startedAt)
			);
		case "model-step-started":
			return (
				isNonEmptyString(event.stepId) &&
				(isUndefined(event.modelId) || isNonEmptyString(event.modelId))
			);
		case "model-step-retry-scheduled":
			return isModelStepRetryScheduledEvent(event);
		case "model-step-retry-ended":
			return isModelStepRetryEndedEvent(event);
		case "text-delta":
		case "reasoning-delta":
			return isString(event.delta);
		case "model-step-finished":
			return (
				isNonEmptyString(event.stepId) &&
				(isUndefined(event.modelId) || isNonEmptyString(event.modelId)) &&
				hasValidOptionalUsage(event)
			);
		case "tool-call-started":
			return (
				"input" in event &&
				isToolCallId(event.toolCallId) &&
				isNonEmptyString(event.toolName)
			);
		case "tool-call-finished":
			return (
				isToolCallId(event.toolCallId) &&
				isNonEmptyString(event.toolName) &&
				isToolCallOutput(event.outcome)
			);
		case "agent-turn-completed":
			return (
				isFiniteNonNegativeNumber(event.finishedAt) &&
				(isUndefined(event.outputLimitReached) ||
					event.outputLimitReached === true) &&
				hasValidOptionalUsage(event) &&
				hasValidOptionalAttempts(event)
			);
		case "agent-turn-cancelled":
			return (
				isFiniteNonNegativeNumber(event.finishedAt) &&
				isOperationalFailure(event.failure) &&
				event.failure.code === "cancelled" &&
				hasValidOptionalUsage(event) &&
				hasValidOptionalAttempts(event)
			);
		case "agent-turn-interrupted":
			return (
				isFiniteNonNegativeNumber(event.finishedAt) &&
				isOperationalFailure(event.failure) &&
				event.failure.code === "interrupted" &&
				(AGENT_TURN_INTERRUPTION_REASONS as readonly string[]).includes(
					String(event.reason)
				) &&
				hasValidOptionalUsage(event) &&
				hasValidOptionalAttempts(event)
			);
		case "agent-turn-failed":
			return (
				isFiniteNonNegativeNumber(event.finishedAt) &&
				isOperationalFailure(event.failure) &&
				hasValidOptionalUsage(event) &&
				hasValidOptionalAttempts(event)
			);
		default:
			return false;
	}
};

export const isAgentTurnTerminalEvent = (
	value: unknown
): value is AgentTurnTerminalEvent =>
	isAgentTurnEvent(value) &&
	(AGENT_TURN_EVENT_TERMINAL_TYPES as readonly string[]).includes(value.type);

/** Reads the monotonic event sequence of an Agent Turn Event. */
export const agentTurnEventSequence = (event: AgentTurnEvent): number =>
	event.sequence;
