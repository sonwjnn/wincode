import type { ConversationMessage } from "./message";
import {
	isConversationToolPart,
	isTerminalConversationToolPart,
} from "./message";

/**
 * Returns the logical attempt after a user message. Retry results may be
 * appended after later user turns, so source-linked messages remain part of
 * this attempt even when storage order crosses the next user boundary.
 */
export const getConversationAttemptMessages = (
	messages: readonly ConversationMessage[],
	userIndex: number
): readonly ConversationMessage[] => {
	const nextUserIndex = messages.findIndex(
		(message, index) => index > userIndex && message.role === "user"
	);
	const userMessage = messages[userIndex];
	if (userMessage === undefined) {
		return messages.slice(
			userIndex + 1,
			nextUserIndex === -1 ? undefined : nextUserIndex
		);
	}
	const attemptMessages = messages
		.slice(userIndex + 1, nextUserIndex === -1 ? undefined : nextUserIndex)
		.filter(
			(message) =>
				message.metadata?.sourceUserMessageId === undefined ||
				message.metadata.sourceUserMessageId === userMessage.id
		);
	if (nextUserIndex === -1) {
		return attemptMessages;
	}
	const linkedMessages = messages
		.slice(nextUserIndex)
		.filter(
			(message) => message.metadata?.sourceUserMessageId === userMessage.id
		);
	return linkedMessages.length === 0
		? attemptMessages
		: [...attemptMessages, ...linkedMessages];
};

export const hasCompletedToolArtifact = (
	attemptMessages: readonly ConversationMessage[]
): boolean =>
	attemptMessages.some(
		(message) =>
			message.role === "assistant" &&
			message.parts.some(
				(part) =>
					isConversationToolPart(part) && isTerminalConversationToolPart(part)
			)
	);
