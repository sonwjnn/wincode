import type { AgentTurnEvent } from "./events";
import type { AgentTurn } from "./turn";

/** Options for one Agent Runtime invocation. */
export type AgentRuntimeRunOptions = {
	/** Aborts the running turn. Consumers own the signal. */
	readonly signal?: AbortSignal;
};

/**
 * The asynchronous sequence of Agent Turn Events one runtime invocation
 * yields. Ordering, errors, and backpressure flow through this one stream:
 * consumers pull events, and a run that reaches a model outcome emits exactly
 * one terminal event (`agent-turn-completed` or `agent-turn-failed`). A run
 * stopped by caller abort yields no terminal event: cancellation is
 * distinguished from outcomes by the caller's AbortSignal, never by a fake
 * terminal event. Invariant violations surface as thrown errors with typed
 * causes rather than failure events.
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
