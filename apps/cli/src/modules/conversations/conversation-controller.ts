import {
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnEvent,
	type AgentTurnLifecycle,
	type AgentTurnTerminalEvent,
	createAgentTurnLifecycle,
} from "@wincode/agent-core";
import {
	type ConversationOperation,
	type ConversationSendExecutor,
	type ConversationSendInput,
	type ConversationSendOutcome,
	createConversationOperation,
} from "./conversation-operation";

export type ConversationControllerStatus = "ready" | "running";

export type ConversationControllerState = {
	readonly lastOutcome?: ConversationSendOutcome;
	readonly status: ConversationControllerStatus;
};

export type ConversationApprovalOutcome =
	| { readonly decision: "allow"; readonly remember: boolean }
	| { readonly decision: "reject"; readonly feedback?: string }
	| { readonly decision: "abort" };

export type ConversationControllerOptions = {
	execute: ConversationSendExecutor;
	deadlineMs?: number;
	onInterrupt?: (preserveToolCallId?: string) => void;
	resolveApproval?: (
		approvalId: string,
		outcome: ConversationApprovalOutcome
	) => void | Promise<void>;
	onError?: (error: unknown) => void;
};
export type ConversationController = {
	readonly cancel: ConversationOperation["cancel"];
	readonly interrupt: ConversationOperation["interrupt"];
	readonly getState: () => ConversationControllerState;
	readonly respondToApproval: (
		approvalId: string,
		outcome: ConversationApprovalOutcome
	) => Promise<void>;
	readonly send: (
		input: ConversationSendInput
	) => Promise<ConversationSendOutcome>;
	readonly submit: (
		input: ConversationSendInput
	) => Promise<ConversationSendOutcome>;
	readonly subscribe: (
		listener: (state: ConversationControllerState) => void
	) => () => void;
	readonly waitForIdle: ConversationOperation["waitForIdle"];
};
export type ConversationViewState = {
	readonly lastEventType?: AgentTurnEvent["type"];
	readonly lastSequence: number;
	readonly reasoningText: string;
	readonly status: "idle" | "streaming" | "terminal";
	readonly text: string;
	readonly turnId: string;
};
export type AgentTurnEventConsumerOptions = {
	lifecycle?: AgentTurnLifecycle;
	onViewState?: (state: ConversationViewState) => void;
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
 * conversation layer that iterates an Agent Runtime; projections and durable
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
	let viewState: ConversationViewState = {
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

export const createConversationController = ({
	deadlineMs,
	execute,
	onError,
	onInterrupt,
	resolveApproval,
}: ConversationControllerOptions): ConversationController => {
	const listeners = new Set<(state: ConversationControllerState) => void>();
	let active = false;
	let state: ConversationControllerState = { status: "ready" };
	const operation = createConversationOperation({
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
	const publish = (next: ConversationControllerState): void => {
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
		input: ConversationSendInput
	): Promise<ConversationSendOutcome> => {
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
				reportError(new Error("Conversation approval adapter is unavailable."));
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
