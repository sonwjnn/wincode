/**
 * The turn-continuation policy for the AI SDK chat loop.
 *
 * The SDK (ai@6) auto-continues a turn whenever the last assistant step's
 * tool calls all have outputs and no request is in flight. Two windows made
 * an interrupted turn resume on its own:
 *
 * 1. the tool-execution gap: the stream ended (status "ready") while tool
 *    executions still run; their late outputs re-trigger
 *    `sendAutomaticallyWhen` — and `chat.stop()` no-ops on "ready".
 * 2. mid-stream abort: the abort finalizes the request, but already
 *    dispatched executions keep running and their late outputs restart it.
 *
 * `createAutoSendGate` gates `sendAutomaticallyWhen` on interrupt state;
 * `hasPendingToolExecutionStep` keeps `isBusy` true across the gap and can
 * never stick true forever (input-streaming parts were never dispatched;
 * restored messages carry no in-flight execution).
 */
import type { CodingAgentUIMessage } from "@wincode/ai";
import { isToolUIPart, lastAssistantMessageIsCompleteWithToolCalls } from "ai";

export type AutoSendGate = {
	/**
	 * Gates `sendAutomaticallyWhen` so an interrupted turn never resumes on
	 * its own. The AI SDK auto-continues a turn whenever the last assistant
	 * step's tool calls all have outputs AND no request is in flight — which
	 * includes two windows where the user's interrupt must win:
	 *
	 * 1. the tool-execution gap: the stream ended (status "ready"), tool
	 *    executions are still running, and the user interrupts;
	 *    `chat.stop()` no-ops on "ready", so without this gate the turn
	 *    resumes the moment the in-flight tool output lands.
	 * 2. mid-stream abort: the abort finalizes the request, but tool
	 *    executions that were already dispatched keep running and their
	 *    late outputs would re-trigger `sendAutomaticallyWhen`.
	 *
	 * A single per-turn boolean is sufficient: within a live session,
	 * `isBusy` (which includes in-flight tool executions) blocks a new
	 * submit until the interrupted turn's outputs have landed, so no stale
	 * execution can fire auto-send after `enable()`; after a reload no
	 * execution is in flight at all.
	 */
	/** Disables auto-send: the current turn was interrupted. */
	disable: () => void;
	/** Re-enables auto-send: a new turn is starting. */
	enable: () => void;
	shouldAutoSend: (arg: { messages: CodingAgentUIMessage[] }) => boolean;
};
export const createAutoSendGate = (): AutoSendGate => {
	let turnInterrupted = false;
	return {
		disable: () => {
			turnInterrupted = true;
		},
		enable: () => {
			turnInterrupted = false;
		},
		shouldAutoSend: ({ messages }) =>
			!turnInterrupted &&
			lastAssistantMessageIsCompleteWithToolCalls({ messages }),
	};
};
const isTerminalToolOutputState = (state: string): boolean =>
	state === "output-available" || state === "output-error";

/**
 * True when the latest assistant step still has tool executions in flight.
 * Mirrors the AI SDK's completion predicate, inverted: the SDK drops to
 * status "ready" between agentic steps (stream ended, tools executing), so
 * `isBusy` derived from status alone makes the turn look stopped and
 * restarted. This closes that gap from the messages the SDK already exposes.
 *
 * `input-streaming` parts are excluded: the SDK only dispatches an execution
 * when the tool input becomes available, so a part aborted mid-input never
 * had an execution started and no output will ever arrive — counting it
 * would hold `isBusy` true forever. While the stream is live, `status`
 * already covers busy for these parts.
 *
 * `loadedMessageIds` skips messages restored from storage: their tool
 * executions died with the old process, so a pending part persisted by an
 * interrupt-and-quit would otherwise hold `isBusy` true forever. In a live
 * session the interrupted message id is never in the set, so the busy
 * indicator still covers the in-flight executions until they land.
 */
export const hasPendingToolExecutionStep = (
	messages: CodingAgentUIMessage[],
	loadedMessageIds?: ReadonlySet<string>
): boolean => {
	const message = messages.at(-1);
	if (!message || message.role !== "assistant") {
		return false;
	}
	if (loadedMessageIds?.has(message.id)) {
		return false;
	}
	const lastStepStartIndex = message.parts.reduce(
		(lastIndex, part, index) =>
			part.type === "step-start" ? index : lastIndex,
		-1
	);
	// The same part set the SDK's completion predicate considers: static
	// `tool-*` parts plus `dynamic-tool` parts, excluding provider-executed
	// calls and never-dispatched input-streaming parts. Any dispatched call
	// that has not reached a terminal output state means the turn is still
	// running while the SDK reports status "ready".
	const lastStepToolCalls = message.parts
		.slice(lastStepStartIndex + 1)
		.filter(isToolUIPart)
		.filter((part) => !part.providerExecuted)
		.filter((part) => part.state !== "input-streaming");
	return lastStepToolCalls.some(
		(part) => !isTerminalToolOutputState(part.state)
	);
};
