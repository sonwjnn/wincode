import { isReasoningUIPart, isTextUIPart, isToolUIPart } from "ai";
import type { CodingAgentUIMessage } from "./message";

/**
 * Tool part states that carry a terminal result the model can safely replay.
 * Everything else (streaming/available input, in-flight approvals) has no
 * output — replaying it as a tool call without a result throws
 * `MissingToolResultsError` at the model boundary.
 */
const TOOL_RESULT_STATES = [
	"output-available",
	"output-error",
	"output-denied",
] as const;
const TOOL_RESULT_STATE_SET = new Set<string>(TOOL_RESULT_STATES);

type ToolPartWithResult = Extract<
	CodingAgentUIMessage["parts"][number],
	{ state: (typeof TOOL_RESULT_STATES)[number] }
>;

const isToolPartWithResult = (
	part: CodingAgentUIMessage["parts"][number]
): part is ToolPartWithResult =>
	isToolUIPart(part) && TOOL_RESULT_STATE_SET.has(part.state);

/**
 * Reduces one part of an interrupted assistant message for model replay.
 * Keeps what carries replayable content (text, reasoning, completed/refused
 * tool results) and drops everything structural or unfinished (step markers,
 * sources, files, in-flight tool calls) — an unfinished tool call has no
 * result to replay and throws `MissingToolResultsError` at the model boundary.
 */
const sanitizeInterruptedPart = (
	part: CodingAgentUIMessage["parts"][number]
): CodingAgentUIMessage["parts"] => {
	if (isTextUIPart(part)) {
		// Keep visible text, but omit stale provider metadata — OpenAI
		// discards item IDs from cancelled streams.
		return [{ text: part.text, type: "text" }];
	}
	if (isReasoningUIPart(part)) {
		// Reasoning is context, not a side effect; replay it without
		// provider metadata that may reference a dead stream.
		return [{ text: part.text, type: "reasoning" }];
	}
	if (isToolPartWithResult(part)) {
		// Completed/refused tool parts carry the side-effect record:
		// replaying them stops the model from re-running tools whose
		// outcome is already known. Unfinished tool calls are dropped
		// (no result to replay), as are their provider metadata.
		if ("resultProviderMetadata" in part) {
			const { callProviderMetadata, resultProviderMetadata, ...rest } = part;
			return [{ ...rest }];
		}
		const { callProviderMetadata, ...rest } = part;
		return [{ ...rest }];
	}
	return [];
};

export const sanitizeInterruptedMessagesForModel = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] => {
	const output: CodingAgentUIMessage[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !message.metadata?.interrupted) {
			output.push(message);
			continue;
		}

		const parts = message.parts.flatMap(sanitizeInterruptedPart);
		if (parts.length > 0) {
			output.push({ ...message, parts });
		}
	}
	return output;
};
