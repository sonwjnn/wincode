import { isUndefined } from "@wincode/runtime-utils";
import type { SessionViewState } from "../hooks/runtime-turn";
import type { SessionExecution, SessionSnapshot } from "./types";

/** Whether a candidate snapshot changes any fact the current one holds. */
export const hasChanged = (
	state: SessionSnapshot,
	changes: Partial<SessionSnapshot>
): boolean =>
	(Object.keys(changes) as (keyof SessionSnapshot)[]).some(
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

/**
 * The newest entry that is not a delegated Subagent, else the newest entry: the
 * Agent Turn execution the session's own sends run as, and the execution an
 * interrupt or an approval abort reaches. A delegated Subagent never takes that
 * place while its parent is live, and an entry that is gone simply is not there.
 */
export const primaryEntry = <T extends { readonly parent?: unknown }>(
	entries: Iterable<T>
): T | undefined => {
	let primary: T | undefined;
	let last: T | undefined;
	for (const entry of entries) {
		last = entry;
		if (isUndefined(entry.parent)) {
			primary = entry;
		}
	}
	return primary ?? last;
};

/**
 * Whether the session is busy: an Agent Turn is running, a compaction is in
 * flight, or the session is waiting on an approval it asked for. It is derived
 * from the snapshot's facts, so a view never keeps its own notion of a running
 * session.
 */
export const isSessionBusy = (snapshot: SessionSnapshot): boolean =>
	snapshot.turnActive ||
	snapshot.isCompacting ||
	snapshot.approvals.some((approval) => isUndefined(approval.decision));
