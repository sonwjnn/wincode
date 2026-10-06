import { getErrorMessage } from "@wincode/utils";
import type { GateOutcome } from "./tool-gate";

const ABORTED_TOOL_TEXT = "Tool call aborted";

/**
 * Settles a Gate evaluation against the executor abort signal: an aborted
 * execution denies the pending evaluation immediately instead of awaiting an
 * approval that can no longer be answered.
 */
export const evaluateGateWithAbort = (
	evaluate: () => Promise<GateOutcome>,
	signal: AbortSignal | undefined
): Promise<GateOutcome> => {
	if (signal === undefined) {
		return evaluate();
	}
	if (signal.aborted) {
		return Promise.resolve({ errorText: ABORTED_TOOL_TEXT, kind: "deny" });
	}
	const { promise, resolve } = Promise.withResolvers<GateOutcome>();
	let settled = false;
	const settle = (outcome: GateOutcome): void => {
		if (settled) {
			return;
		}
		settled = true;
		signal.removeEventListener("abort", onAbort);
		resolve(outcome);
	};
	const onAbort = (): void => {
		settle({ errorText: ABORTED_TOOL_TEXT, kind: "deny" });
	};
	signal.addEventListener("abort", onAbort, { once: true });
	void evaluate().then(settle, (error: unknown) => {
		settle(
			signal.aborted
				? { errorText: ABORTED_TOOL_TEXT, kind: "deny" }
				: {
						errorText: getErrorMessage(error, "Tool execution failed."),
						kind: "deny",
					}
		);
	});
	return promise;
};
