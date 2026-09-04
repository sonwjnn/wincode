import type { ModelUsage } from "@wincode/ai/model-usage";
import { modelUsageSchema } from "@wincode/ai/model-usage";
import type { OperationalFailure } from "./failures";
import { isOperationalFailure } from "./failures";
import type { ModelStepId } from "./model-step";
import type { ToolCallId, ToolCallOutput } from "./tools";
import { isToolCallOutput } from "./tools";
import {
	AGENT_TURN_INTERRUPTION_REASONS,
	type AgentTurnDelegation,
	type AgentTurnId,
	type AgentTurnInterruptionReason,
	isAgentTurnDelegation,
} from "./turn";

/**
 * Common shape of every Agent Turn Event: the Agent Turn identity and a
 * monotonic sequence within that turn. Sequence increases by one per emitted
 * event so consumers can order and correlate a single turn.
 */
export type AgentTurnEventBase = {
	readonly sequence: number;
	readonly turnId: AgentTurnId;
};

/** The turn began. The first event of a run. */
export type AgentTurnStartedEvent = AgentTurnEventBase & {
	readonly agentId: string;
	readonly delegation?: AgentTurnDelegation;
	readonly startedAt: number;
	readonly type: "agent-turn-started";
};

/** One model invocation within the turn started. */
export type ModelStepStartedEvent = AgentTurnEventBase & {
	readonly modelId?: string;
	readonly stepId: ModelStepId;
	readonly type: "model-step-started";
};

/** A streamed text delta from the current Model Step. */
export type TextDeltaEvent = AgentTurnEventBase & {
	readonly delta: string;
	readonly type: "text-delta";
};

/** A streamed reasoning delta from the current Model Step. */
export type ReasoningDeltaEvent = AgentTurnEventBase & {
	readonly delta: string;
	readonly type: "reasoning-delta";
};

/** One model invocation finished with its usage. */
export type ModelStepFinishedEvent = AgentTurnEventBase & {
	readonly modelId?: string;
	readonly stepId: ModelStepId;
	readonly type: "model-step-finished";
	readonly usage?: ModelUsage;
};

/** The Agent requested one Tool Call with a complete input. */
export type ToolCallStartedEvent = AgentTurnEventBase & {
	readonly input: unknown;
	readonly toolCallId: ToolCallId;
	readonly toolName: string;
	readonly type: "tool-call-started";
};

/** One Tool Call reached its output, failure, deny, or rejection outcome. */
export type ToolCallFinishedEvent = AgentTurnEventBase & {
	readonly outcome: ToolCallOutput;
	readonly toolCallId: ToolCallId;
	readonly toolName: string;
	readonly type: "tool-call-finished";
};

/** The turn reached its terminal `completed` outcome. */
export type AgentTurnCompletedEvent = AgentTurnEventBase & {
	readonly finishedAt: number;
	readonly type: "agent-turn-completed";
	readonly usage?: ModelUsage;
};

/** The caller cancelled the turn. */
export type AgentTurnCancelledEvent = AgentTurnEventBase & {
	readonly failure: OperationalFailure;
	readonly finishedAt: number;
	readonly type: "agent-turn-cancelled";
};

/** The turn stopped without completion, failure, or caller cancellation. */
export type AgentTurnInterruptedEvent = AgentTurnEventBase & {
	readonly failure: OperationalFailure;
	readonly finishedAt: number;
	readonly reason: AgentTurnInterruptionReason;
	readonly type: "agent-turn-interrupted";
};

/** The turn reached an expected operational failure. */
export type AgentTurnFailedEvent = AgentTurnEventBase & {
	readonly failure: OperationalFailure;
	readonly finishedAt: number;
	readonly type: "agent-turn-failed";
};

export type AgentTurnTerminalEvent =
	| AgentTurnCancelledEvent
	| AgentTurnCompletedEvent
	| AgentTurnFailedEvent
	| AgentTurnInterruptedEvent;

export type AgentTurnEvent =
	| AgentTurnStartedEvent
	| ModelStepStartedEvent
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ModelStepFinishedEvent
	| ToolCallStartedEvent
	| ToolCallFinishedEvent
	| AgentTurnTerminalEvent;

export const AGENT_TURN_EVENT_TYPES = [
	"agent-turn-started",
	"model-step-started",
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

const isFiniteTimestamp = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;
const isUsage = (value: unknown): value is ModelUsage =>
	modelUsageSchema.safeParse(value).success;

const isToolIdentity = (value: unknown): value is ToolCallId => {
	if (typeof value !== "string") {
		return false;
	}
	return value.length > 0;
};

const hasBaseEvent = (value: unknown): value is AgentTurnEventBase => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const event = value as Record<string, unknown>;
	return (
		typeof event.turnId === "string" &&
		event.turnId.length > 0 &&
		isNonNegativeInteger(event.sequence)
	);
};

export const isAgentTurnEvent = (value: unknown): value is AgentTurnEvent => {
	if (!hasBaseEvent(value)) {
		return false;
	}
	const event = value as Record<string, unknown>;
	if (
		typeof event.type !== "string" ||
		!(AGENT_TURN_EVENT_TYPES as readonly string[]).includes(event.type)
	) {
		return false;
	}
	switch (event.type) {
		case "agent-turn-started":
			return (
				typeof event.agentId === "string" &&
				event.agentId.length > 0 &&
				(event.delegation === undefined ||
					isAgentTurnDelegation(event.delegation)) &&
				isFiniteTimestamp(event.startedAt)
			);
		case "model-step-started":
			return (
				typeof event.stepId === "string" &&
				event.stepId.length > 0 &&
				(event.modelId === undefined ||
					(typeof event.modelId === "string" && event.modelId.length > 0))
			);
		case "text-delta":
		case "reasoning-delta":
			return typeof event.delta === "string";
		case "model-step-finished":
			return (
				typeof event.stepId === "string" &&
				event.stepId.length > 0 &&
				(event.modelId === undefined ||
					(typeof event.modelId === "string" && event.modelId.length > 0)) &&
				(event.usage === undefined || isUsage(event.usage))
			);
		case "tool-call-started":
			return (
				"input" in event &&
				isToolIdentity(event.toolCallId) &&
				typeof event.toolName === "string" &&
				event.toolName.length > 0
			);
		case "tool-call-finished":
			return (
				isToolIdentity(event.toolCallId) &&
				typeof event.toolName === "string" &&
				event.toolName.length > 0 &&
				isToolCallOutput(event.outcome)
			);
		case "agent-turn-completed":
			return (
				isFiniteTimestamp(event.finishedAt) &&
				(event.usage === undefined || isUsage(event.usage))
			);
		case "agent-turn-cancelled":
			return (
				isFiniteTimestamp(event.finishedAt) &&
				isOperationalFailure(event.failure) &&
				event.failure.code === "cancelled"
			);
		case "agent-turn-interrupted":
			return (
				isFiniteTimestamp(event.finishedAt) &&
				isOperationalFailure(event.failure) &&
				event.failure.code === "interrupted" &&
				(AGENT_TURN_INTERRUPTION_REASONS as readonly string[]).includes(
					String(event.reason)
				)
			);
		case "agent-turn-failed":
			return (
				isFiniteTimestamp(event.finishedAt) &&
				isOperationalFailure(event.failure)
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
