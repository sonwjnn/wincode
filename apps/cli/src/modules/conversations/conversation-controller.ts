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
