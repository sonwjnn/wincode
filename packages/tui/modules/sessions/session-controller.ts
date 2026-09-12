import {
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnEvent,
	type AgentTurnLifecycle,
	type AgentTurnTerminalEvent,
	createAgentTurnLifecycle,
} from "@wincode/agent-core";
import {
	createSessionOperation,
	type SessionOperation,
	type SessionSendExecutor,
	type SessionSendInput,
	type SessionSendOutcome,
} from "./session-operation";

export type SessionControllerStatus = "ready" | "running";

export type SessionControllerState = {
	readonly lastOutcome?: SessionSendOutcome;
	readonly status: SessionControllerStatus;
};

export type SessionApprovalOutcome =
	| { readonly decision: "allow"; readonly remember: boolean }
	| { readonly decision: "reject"; readonly feedback?: string }
	| { readonly decision: "abort" };

export type SessionControllerOptions = {
	execute: SessionSendExecutor;
	deadlineMs?: number;
	onInterrupt?: (preserveToolCallId?: string) => void;
	resolveApproval?: (
		approvalId: string,
		outcome: SessionApprovalOutcome
	) => void | Promise<void>;
	onError?: (error: unknown) => void;
};
export type SessionController = {
	readonly cancel: SessionOperation["cancel"];
	readonly interrupt: SessionOperation["interrupt"];
	readonly getState: () => SessionControllerState;
	readonly respondToApproval: (
		approvalId: string,
		outcome: SessionApprovalOutcome
	) => Promise<void>;
	readonly send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	readonly submit: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	readonly subscribe: (
		listener: (state: SessionControllerState) => void
	) => () => void;
	readonly waitForIdle: SessionOperation["waitForIdle"];
};
export type SessionViewState = {
	readonly delegation?: AgentTurn["delegation"];
	readonly lastEventType?: AgentTurnEvent["type"];
	readonly lastSequence: number;
	readonly reasoningText: string;
	readonly status: "idle" | "streaming" | "terminal";
	readonly text: string;
	readonly turnId: string;
};
export type AgentTurnEventConsumerOptions = {
	lifecycle?: AgentTurnLifecycle;
	onViewState?: (state: SessionViewState) => void;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	turn: AgentTurn;
	onEvent: (event: AgentTurnEvent) => void | Promise<void>;
	onTerminal: (event: AgentTurnTerminalEvent) => void | Promise<void>;
};
const isTerminalEvent = (
	event: AgentTurnEvent
): event is AgentTurnTerminalEvent =>
	event.type === "agent-turn-completed" ||
	event.type === "agent-turn-failed" ||
	event.type === "agent-turn-cancelled" ||
	event.type === "agent-turn-interrupted";

/**
 * The application-owned runtime boundary. It is the only function in the
 * session layer that iterates an Agent Runtime; projections and durable
 * checkpoint callbacks run in event order after lifecycle reduction.
 */
export const consumeAgentTurnEvents = async ({
	lifecycle: providedLifecycle,
	onEvent,
	onTerminal,
	onViewState,
	runtime,
	turn,
	signal,
}: AgentTurnEventConsumerOptions): Promise<void> => {
	const lifecycle = providedLifecycle ?? createAgentTurnLifecycle(turn.id);
	let viewState: SessionViewState = {
		delegation: turn.delegation,
		lastSequence: -1,
		reasoningText: "",
		status: "idle",
		text: "",
		turnId: turn.id,
	};
	const publishViewState = (event: AgentTurnEvent): void => {
		if (event.type === "text-delta") {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				status: "streaming",
				text: viewState.text + event.delta,
			};
		} else if (event.type === "reasoning-delta") {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				reasoningText: viewState.reasoningText + event.delta,
				status: "streaming",
			};
		} else {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				status: "streaming",
			};
		}
		try {
			onViewState?.(viewState);
		} catch {
			// Presentation subscribers are observational only.
		}
	};
	for await (const event of runtime.run(turn, { signal })) {
		if (
			signal?.aborted &&
			!isTerminalEvent(event) &&
			event.type !== "agent-turn-started"
		) {
			break;
		}
		if (isTerminalEvent(event)) {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				status: "terminal",
			};
			try {
				onViewState?.(viewState);
			} catch {
				// Presentation subscribers are observational only.
			}
			await onTerminal(event);
			return;
		}
		lifecycle.apply(event);
		publishViewState(event);
		await onEvent(event);
	}
};

export const createSessionController = ({
	deadlineMs,
	execute,
	onError,
	onInterrupt,
	resolveApproval,
}: SessionControllerOptions): SessionController => {
	const listeners = new Set<(state: SessionControllerState) => void>();
	let active = false;
	let state: SessionControllerState = { status: "ready" };
	const operation = createSessionOperation({
		deadlineMs,
		execute,
		onInterrupt,
	});

	const reportError = (error: unknown): void => {
		try {
			onError?.(error);
		} catch {
			// Telemetry and presentation adapters are observational only.
		}
	};
	const publish = (next: SessionControllerState): void => {
		state = next;
		for (const listener of listeners) {
			try {
				listener(state);
			} catch {
				// A view subscriber cannot change turn lifecycle state.
			}
		}
	};

	const submit = async (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		if (active) {
			return operation.send(input);
		}
		active = true;
		publish({ status: "running" });
		try {
			const outcome = await operation.send(input);
			publish({ lastOutcome: outcome, status: "ready" });
			return outcome;
		} catch (error) {
			publish({ status: "ready" });
			reportError(error);
			throw error;
		} finally {
			active = false;
		}
	};

	return {
		cancel: operation.cancel,
		getState: () => state,
		interrupt: operation.interrupt,
		respondToApproval: async (approvalId, outcome) => {
			if (resolveApproval === undefined) {
				reportError(new Error("Session approval adapter is unavailable."));
				return;
			}
			try {
				await resolveApproval(approvalId, outcome);
			} catch (error) {
				reportError(error);
			}
		},
		send: submit,
		submit,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		waitForIdle: operation.waitForIdle,
	};
};
