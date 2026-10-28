import type { AgentTurnId, SessionMessageId } from "@wincode/agent-core";
import { isUndefined } from "@wincode/utils";
import type { SessionExecution } from "./types";

/**
 * The Agent Session's in-memory record of the Agent Turn Executions it must not
 * forget yet, and of the callers waiting for one to end.
 *
 * `LiveSessionSnapshot.executions` stays the authority for what is running;
 * this module never keeps a second copy of it. It owns only the two facts the
 * published list cannot carry: an execution retained past its live removal so
 * terminal persistence can still find it, and the callers parked on that
 * execution's end.
 */
export type ExecutionRegistry = Readonly<{
	/** The assistant message a retained or live execution is reporting under. */
	assistantIdFor: (turnId: AgentTurnId) => SessionMessageId | undefined;
	/**
	 * Ends the execution: retains it for the caller that still owes it terminal
	 * persistence, forgets it otherwise, then wakes everything waiting on it.
	 */
	end: (turnId: AgentTurnId, retain?: SessionExecution) => void;
	/** Re-points a retained execution at the assistant message that replaced its first attempt. */
	reassignAssistantId: (
		turnId: AgentTurnId,
		assistantId: SessionMessageId
	) => void;
	/**
	 * Resolves after the execution ends. Resolves immediately for a turn this
	 * registry never saw, so a caller parked on a finished turn cannot hang.
	 */
	waitForEnd: (turnId: AgentTurnId) => Promise<void>;
}>;

export type ExecutionRegistryDependencies = Readonly<{
	/** Whether the published Snapshot still lists this turn as an execution. */
	isLive: (turnId: AgentTurnId) => boolean;
}>;

export const createExecutionRegistry = ({
	isLive,
}: ExecutionRegistryDependencies): ExecutionRegistry => {
	const settling = new Map<AgentTurnId, SessionExecution>();
	const endWaiters = new Map<AgentTurnId, (() => void)[]>();

	const wake = (turnId: AgentTurnId): void => {
		const waiters = endWaiters.get(turnId);
		if (isUndefined(waiters)) {
			return;
		}
		endWaiters.delete(turnId);
		for (const resolve of waiters) {
			resolve();
		}
	};

	return {
		assistantIdFor: (turnId) => settling.get(turnId)?.assistantId,
		end: (turnId, retain) => {
			if (isUndefined(retain)) {
				settling.delete(turnId);
			} else {
				settling.set(turnId, retain);
			}
			wake(turnId);
		},
		reassignAssistantId: (turnId, assistantId) => {
			const retained = settling.get(turnId);
			if (isUndefined(retained)) {
				return;
			}
			settling.set(turnId, { ...retained, assistantId });
		},
		waitForEnd: (turnId) => {
			if (!isLive(turnId)) {
				return Promise.resolve();
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			const waiters = endWaiters.get(turnId);
			if (isUndefined(waiters)) {
				endWaiters.set(turnId, [resolve]);
			} else {
				waiters.push(resolve);
			}
			return promise;
		},
	};
};
