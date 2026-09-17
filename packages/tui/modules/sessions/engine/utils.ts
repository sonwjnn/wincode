import { isUndefined } from "@wincode/runtime-utils";
import type {
	SessionExecution,
	SessionSnapshot,
	SessionViewState,
} from "./types";

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
