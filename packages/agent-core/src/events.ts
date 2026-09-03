import type { ModelUsage } from "@wincode/ai/model-usage";
import type { OperationalFailure } from "./failures";
import type { ModelStepId } from "./model-step";
import type { AgentTurnId } from "./turn";

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

/** The turn reached its terminal `completed` outcome. */
export type AgentTurnCompletedEvent = AgentTurnEventBase & {
	readonly finishedAt: number;
	readonly type: "agent-turn-completed";
	readonly usage?: ModelUsage;
};

/** The turn reached its terminal `failed` outcome. */
export type AgentTurnFailedEvent = AgentTurnEventBase & {
	readonly failure: OperationalFailure;
	readonly finishedAt: number;
	readonly type: "agent-turn-failed";
};

export type AgentTurnEvent =
	| AgentTurnStartedEvent
	| ModelStepStartedEvent
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ModelStepFinishedEvent
	| AgentTurnCompletedEvent
	| AgentTurnFailedEvent;

export const AGENT_TURN_EVENT_TYPES = [
	"agent-turn-started",
	"model-step-started",
	"text-delta",
	"reasoning-delta",
	"model-step-finished",
	"agent-turn-completed",
	"agent-turn-failed",
] as const satisfies readonly AgentTurnEvent["type"][];

export const AGENT_TURN_EVENT_TERMINAL_TYPES = [
	"agent-turn-completed",
	"agent-turn-failed",
] as const satisfies readonly AgentTurnEvent["type"][];

export const isAgentTurnEvent = (value: unknown): value is AgentTurnEvent =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as AgentTurnEvent).type === "string" &&
	typeof (value as AgentTurnEvent).sequence === "number" &&
	typeof (value as AgentTurnEvent).turnId === "string" &&
	(AGENT_TURN_EVENT_TYPES as readonly string[]).includes(
		(value as AgentTurnEvent).type
	);

export const isAgentTurnTerminalEvent = (
	value: AgentTurnEvent
): value is AgentTurnCompletedEvent | AgentTurnFailedEvent =>
	(AGENT_TURN_EVENT_TERMINAL_TYPES as readonly string[]).includes(value.type);

/** Reads the monotonic event sequence of an Agent Turn Event. */
export const agentTurnEventSequence = (event: AgentTurnEvent): number =>
	event.sequence;
