import { isUndefined } from "@wincode/utils";
import type { SessionViewState } from "../hooks/runtime-turn";
import type { LiveSessionSnapshot, SessionExecution } from "./types";

/** Whether a candidate snapshot changes any fact the current one holds. */
export const hasChanged = (
	state: LiveSessionSnapshot,
	changes: Partial<LiveSessionSnapshot>
): boolean =>
	(Object.keys(changes) as (keyof LiveSessionSnapshot)[]).some(
		(key) => !Object.is(state[key], changes[key])
	);

/** The newest live execution that has streamed is the view the session shows. */
export const exposedViewState = (
	executions: readonly SessionExecution[]
): SessionViewState | undefined => {
	for (let index = executions.length - 1; index >= 0; index -= 1) {
		const viewState = executions[index]?.viewState;
		if (!isUndefined(viewState)) {
			return viewState;
		}
	}
	return;
};

/** Returns the most recently active execution, if any. */
export const latestEntry = <T>(entries: Iterable<T>): T | undefined => {
	let last: T | undefined;
	for (const entry of entries) {
		last = entry;
	}
	return last;
};

/**
 * Whether the session is busy: an Agent Turn is running or a compaction is in
 * flight. It is derived from the snapshot's facts, so a view never keeps its
 * own notion of a running session.
 */
export const isSessionBusy = (snapshot: LiveSessionSnapshot): boolean =>
	snapshot.turnActive || snapshot.isCompacting;

/**
 * Whether an execution is available to receive a Steering Message at its next
 * Model Step boundary. A submission can be active while preparing or settling
 * without a live execution to steer.
 */
export const acceptsSteeringMessages = (
	snapshot: LiveSessionSnapshot
): boolean => snapshot.turnActive && snapshot.executions.length > 0;
