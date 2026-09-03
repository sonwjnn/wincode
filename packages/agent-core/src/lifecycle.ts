import { AgentInvariantError } from "./errors";
import {
	type AgentTurnCancelledEvent,
	type AgentTurnEvent,
	type AgentTurnInterruptedEvent,
	type AgentTurnTerminalEvent,
	isAgentTurnEvent,
} from "./events";
import { createOperationalFailure } from "./failures";
import type { ModelStepId } from "./model-step";
import type {
	AgentTurnId,
	AgentTurnInterruptionReason,
	AgentTurnStatus,
} from "./turn";

export type AgentTurnLifecycleState = {
	readonly activeStepId?: ModelStepId;
	readonly lastSequence: number;
	readonly started: boolean;
	readonly status: AgentTurnStatus;
	readonly terminalEvent?: AgentTurnTerminalEvent;
	readonly turnId: AgentTurnId;
};

export type AgentTurnLifecycle = {
	apply: (event: AgentTurnEvent) => AgentTurnLifecycleState;
	cancel: (sequence?: number) => AgentTurnCancelledEvent;
	getState: () => AgentTurnLifecycleState;
	interrupt: (
		sequence?: number,
		reason?: AgentTurnInterruptionReason
	) => AgentTurnInterruptedEvent;
};

const isTerminalEvent = (
	event: AgentTurnEvent
): event is AgentTurnTerminalEvent =>
	event.type === "agent-turn-completed" ||
	event.type === "agent-turn-failed" ||
	event.type === "agent-turn-cancelled" ||
	event.type === "agent-turn-interrupted";

const statusForTerminalEvent = (
	event: AgentTurnTerminalEvent
): AgentTurnStatus => {
	switch (event.type) {
		case "agent-turn-cancelled":
			return "cancelled";
		case "agent-turn-completed":
			return "completed";
		case "agent-turn-failed":
			return "failed";
		case "agent-turn-interrupted":
			return "interrupted";
		default:
			throw new AgentInvariantError(
				"invalid-event",
				"Agent Turn received an unknown terminal event.",
				{ cause: event }
			);
	}
};

const assertInterruptible = (state: AgentTurnLifecycleState): void => {
	if (state.terminalEvent !== undefined) {
		throw new AgentInvariantError(
			"duplicate-terminal-outcome",
			`Agent Turn ${state.turnId} already has a terminal outcome.`,
			{ cause: state.terminalEvent }
		);
	}
	if (!state.started) {
		throw new AgentInvariantError(
			"invalid-transition",
			`Agent Turn ${state.turnId} cannot terminate before it starts.`,
			{ cause: state }
		);
	}
};

const createCancelledEvent = (
	turnId: AgentTurnId,
	sequence: number
): AgentTurnCancelledEvent => ({
	failure: createOperationalFailure({
		code: "cancelled",
		details: undefined,
		retry: "never",
		source: "runtime",
	}),
	finishedAt: Date.now(),
	sequence,
	turnId,
	type: "agent-turn-cancelled",
});

const createInterruptedEvent = (
	turnId: AgentTurnId,
	sequence: number,
	reason: AgentTurnInterruptionReason
): AgentTurnInterruptedEvent => ({
	failure: createOperationalFailure({
		code: "interrupted",
		details: undefined,
		retry: "immediate",
		source: "runtime",
	}),
	finishedAt: Date.now(),
	reason,
	sequence,
	turnId,
	type: "agent-turn-interrupted",
});
const assertEventCanApply = (
	state: AgentTurnLifecycleState,
	event: AgentTurnEvent,
	turnId: AgentTurnId
): void => {
	if (!isAgentTurnEvent(event)) {
		throw new AgentInvariantError(
			"invalid-event",
			`Agent Turn ${turnId} received an invalid event.`,
			{ cause: event }
		);
	}
	if (event.turnId !== turnId) {
		throw new AgentInvariantError(
			"turn-mismatch",
			`Agent Turn ${turnId} received event for ${event.turnId}.`,
			{ cause: event }
		);
	}
	if (event.sequence !== state.lastSequence + 1) {
		throw new AgentInvariantError(
			"sequence-out-of-order",
			`Agent Turn ${turnId} expected sequence ${state.lastSequence + 1} but received ${event.sequence}.`,
			{ cause: event }
		);
	}
	if (state.terminalEvent !== undefined) {
		throw new AgentInvariantError(
			"duplicate-terminal-outcome",
			`Agent Turn ${turnId} emitted an event after its terminal outcome.`,
			{ cause: event }
		);
	}
	if (!state.started && event.type !== "agent-turn-started") {
		throw new AgentInvariantError(
			"invalid-transition",
			`Agent Turn ${turnId} must start before emitting ${event.type}.`,
			{ cause: event }
		);
	}
	if (state.started && event.type === "agent-turn-started") {
		throw new AgentInvariantError(
			"invalid-transition",
			`Agent Turn ${turnId} cannot start twice.`,
			{ cause: event }
		);
	}
};

const activeStepIdForEvent = (
	state: AgentTurnLifecycleState,
	event: AgentTurnEvent
): ModelStepId | undefined => {
	switch (event.type) {
		case "model-step-finished":
			return;
		case "model-step-started":
			return event.stepId;
		default:
			return state.activeStepId;
	}
};

export const createAgentTurnLifecycle = (
	turnId: AgentTurnId
): AgentTurnLifecycle => {
	let state: AgentTurnLifecycleState = {
		lastSequence: -1,
		started: false,
		status: "running",
		turnId,
	};

	const apply = (event: AgentTurnEvent): AgentTurnLifecycleState => {
		assertEventCanApply(state, event, turnId);

		if (isTerminalEvent(event)) {
			state = {
				activeStepId: undefined,
				lastSequence: event.sequence,
				started: true,
				status: statusForTerminalEvent(event),
				terminalEvent: event,
				turnId,
			};
			return state;
		}

		state = {
			...state,
			activeStepId: activeStepIdForEvent(state, event),
			lastSequence: event.sequence,
			started: state.started || event.type === "agent-turn-started",
		};
		return state;
	};

	const cancel = (
		sequence = state.lastSequence + 1
	): AgentTurnCancelledEvent => {
		assertInterruptible(state);
		if (sequence !== state.lastSequence + 1) {
			throw new AgentInvariantError(
				"sequence-out-of-order",
				`Agent Turn ${turnId} expected sequence ${state.lastSequence + 1} but received ${sequence}.`,
				{ cause: sequence }
			);
		}
		const event = createCancelledEvent(turnId, sequence);
		apply(event);
		return event;
	};

	const interrupt = (
		sequence = state.lastSequence + 1,
		reason: AgentTurnInterruptionReason = "lost-execution"
	): AgentTurnInterruptedEvent => {
		assertInterruptible(state);
		if (sequence !== state.lastSequence + 1) {
			throw new AgentInvariantError(
				"sequence-out-of-order",
				`Agent Turn ${turnId} expected sequence ${state.lastSequence + 1} but received ${sequence}.`,
				{ cause: sequence }
			);
		}
		const event = createInterruptedEvent(turnId, sequence, reason);
		apply(event);
		return event;
	};

	return { apply, cancel, getState: () => state, interrupt };
};
