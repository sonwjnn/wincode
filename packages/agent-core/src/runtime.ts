import { AgentInvariantError } from "./errors";
import type { AgentTurnEvent, AgentTurnTerminalEvent } from "./events";
import {
	createOperationalFailure,
	type OperationalFailureDetails,
} from "./failures";
import type { AgentTurn } from "./turn";

const TIMEOUT_PATTERN = /(?:deadline|timed? ?out|timeout)/iu;
export const AGENT_TURN_ABORT_REASON_TYPE = "wincode-agent-turn" as const;

export type AgentTurnAbortDisposition =
	| "cancelled"
	| "deadline-exceeded"
	| "interrupted";

export type AgentTurnAbortReason = {
	readonly outcome: AgentTurnAbortDisposition;
	readonly type: typeof AGENT_TURN_ABORT_REASON_TYPE;
};

/** Creates an abort reason that survives through an AbortSignal boundary. */
export const createAgentTurnAbortReason = (
	outcome: AgentTurnAbortDisposition
): AgentTurnAbortReason => ({
	outcome,
	type: AGENT_TURN_ABORT_REASON_TYPE,
});

const isTimeoutLike = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as {
		code?: unknown;
		message?: unknown;
		name?: unknown;
	};
	const text = [candidate.code, candidate.name, candidate.message]
		.filter((entry): entry is string => typeof entry === "string")
		.join(" ");
	return TIMEOUT_PATTERN.test(text);
};

/**
 * Maps an AbortSignal reason to the terminal disposition owned by the Agent
 * runtime. Unknown aborts are caller cancellation; timeout-shaped reasons are
 * deadline expiry.
 */
export const getAgentTurnAbortDisposition = (
	reason: unknown
): AgentTurnAbortDisposition => {
	if (
		typeof reason === "object" &&
		reason !== null &&
		"type" in reason &&
		reason.type === AGENT_TURN_ABORT_REASON_TYPE &&
		"outcome" in reason &&
		(reason.outcome === "cancelled" ||
			reason.outcome === "deadline-exceeded" ||
			reason.outcome === "interrupted")
	) {
		return reason.outcome;
	}
	if (isTimeoutLike(reason)) {
		return "deadline-exceeded";
	}
	return "cancelled";
};
export const getAgentTurnFailureDetails = (
	turn: Pick<AgentTurn, "model">
): OperationalFailureDetails => ({
	modelId: turn.model.modelId,
	providerId: turn.model.providerId,
});

/**
 * Converts an aborted Agent Turn into its explicit terminal event. User
 * cancellation and interruption are statuses; deadline expiry is a failed
 * turn carrying the deadline Operational Failure code.
 */
export const createAgentTurnAbortEvent = (
	turn: Pick<AgentTurn, "id" | "model">,
	signal: AbortSignal,
	sequence: number
): AgentTurnTerminalEvent => {
	if (!signal.aborted) {
		throw new AgentInvariantError(
			"invalid-transition",
			"Agent Turn abort events require an aborted signal.",
			{ cause: signal }
		);
	}
	if (!Number.isInteger(sequence) || sequence < 0) {
		throw new AgentInvariantError(
			"invalid-event",
			"Agent Turn abort events require a non-negative sequence.",
			{ cause: sequence }
		);
	}
	const details = getAgentTurnFailureDetails(turn);
	switch (getAgentTurnAbortDisposition(signal.reason)) {
		case "cancelled":
			return {
				failure: createOperationalFailure({
					code: "cancelled",
					details,
					retry: "never",
					source: "runtime",
				}),
				finishedAt: Date.now(),
				sequence,
				turnId: turn.id,
				type: "agent-turn-cancelled",
			};
		case "deadline-exceeded":
			return {
				failure: createOperationalFailure({
					code: "deadline-exceeded",
					details,
					retry: "never",
					source: "runtime",
				}),
				finishedAt: Date.now(),
				sequence,
				turnId: turn.id,
				type: "agent-turn-failed",
			};
		case "interrupted":
			return {
				failure: createOperationalFailure({
					code: "interrupted",
					details,
					retry: "immediate",
					source: "runtime",
				}),
				finishedAt: Date.now(),
				reason: "user",
				sequence,
				turnId: turn.id,
				type: "agent-turn-interrupted",
			};
		default:
			throw new AgentInvariantError(
				"invalid-runtime",
				"Agent Runtime produced an unknown abort disposition.",
				{ cause: signal.reason }
			);
	}
};

/** Options for one Agent Runtime invocation. */
export type AgentRuntimeRunOptions = {
	/** Aborts the running turn. Consumers own the signal. */
	readonly signal?: AbortSignal;
	/** Optional runtime-owned deadline in milliseconds from invocation. */
	readonly deadlineMs?: number;
};

/**
 * The asynchronous sequence of Agent Turn Events one runtime invocation
 * yields. A run always emits one terminal event: completed, failed, cancelled,
 * or interrupted. Invariant violations surface as typed errors with causes.
 */
export type AgentTurnEventStream = AsyncIterable<AgentTurnEvent>;

/**
 * One deep runtime operation: consume a fully resolved Agent Turn and yield
 * Wincode Agent Turn Events. Model, tool, message, stream, callback,
 * transport, and error types of any underlying runtime never cross this
 * interface.
 */
export type AgentRuntime = {
	run: (
		turn: AgentTurn,
		options?: AgentRuntimeRunOptions
	) => AgentTurnEventStream;
};
