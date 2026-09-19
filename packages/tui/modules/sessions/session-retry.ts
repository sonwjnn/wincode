import { isUndefined } from "@wincode/runtime-utils";
import type { SessionMessage } from "./message";
import { isSessionToolPart, isTerminalSessionToolPart } from "./message";

/**
 * Returns the logical attempt after a user message. Retry results may be
 * appended after later user turns, so source-linked messages remain part of
 * this attempt even when storage order crosses the next user boundary. A user
 * message that joined a running Agent Turn does not end the attempt: it is part
 * of the turn the opener started.
 */
export const getSessionAttemptMessages = (
	messages: readonly SessionMessage[],
	userIndex: number
): readonly SessionMessage[] => {
	const nextUserIndex = messages.findIndex(
		(message, index) =>
			index > userIndex &&
			message.role === "user" &&
			isUndefined(message.metadata?.joinedTurnId)
	);
	const userMessage = messages[userIndex];
	if (isUndefined(userMessage)) {
		return messages.slice(
			userIndex + 1,
			nextUserIndex === -1 ? undefined : nextUserIndex
		);
	}
	const attemptMessages = messages
		.slice(userIndex + 1, nextUserIndex === -1 ? undefined : nextUserIndex)
		.filter(
			(message) =>
				isUndefined(message.metadata?.sourceUserMessageId) ||
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
	attemptMessages: readonly SessionMessage[]
): boolean =>
	attemptMessages.some(
		(message) =>
			message.role === "assistant" &&
			message.parts.some(
				(part) => isSessionToolPart(part) && isTerminalSessionToolPart(part)
			)
	);
