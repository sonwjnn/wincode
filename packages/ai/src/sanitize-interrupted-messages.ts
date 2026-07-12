import type { CodingAgentUIMessage } from "./message";

export const sanitizeInterruptedMessagesForModel = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] =>
	messages.flatMap<CodingAgentUIMessage>((message) => {
		if (message.role !== "assistant" || !message.metadata?.interrupted) {
			return [message];
		}

		const textParts = message.parts.flatMap((part) =>
			part.type === "text" ? [{ text: part.text, type: "text" as const }] : []
		);

		// OpenAI discards item IDs from cancelled streams. Keep visible text as
		// history, but omit stale provider metadata and unfinished tool calls.
		return textParts.length === 0 ? [] : [{ ...message, parts: textParts }];
	});
