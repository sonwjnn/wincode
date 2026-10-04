import type { SessionMessageId } from "@wincode/agent-core";
import { normalizeChatModelSelection } from "@wincode/ai/models";
import { isNull, isString, isUndefined } from "@wincode/utils";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "@/modules/sessions/session-retry";

export type SessionTurn = {
	id: string;
	messages: SessionMessage[];
};

export const resolveTurnMetadataSignature = (
	message: SessionMessage
): string | null => {
	const metadata = message.metadata;
	if (!metadata) {
		return null;
	}

	const agent = metadata.agent ?? "";
	const normalizedModel = normalizeChatModelSelection(metadata.model ?? "");
	let modelKey = "";

	if (normalizedModel) {
		modelKey = `${normalizedModel.providerId}/${normalizedModel.modelId}`;
	} else if (isString(metadata.model)) {
		modelKey = metadata.model;
	} else if (metadata.model) {
		modelKey = `${metadata.model.providerId}/${metadata.model.modelId}`;
	}
	const interrupted = metadata.interrupted === true ? "1" : "0";
	const effort = metadata.effort ?? "";
	const reasoningMode = metadata.reasoningMode ?? "";

	return `${agent}|${modelKey}|${effort}|${reasoningMode}|${interrupted}`;
};

const resolveTurnMetadataMessage = (
	turn: SessionTurn
): SessionMessage | undefined => {
	const assistant = turn.messages.findLast(
		(message) => message.role === "assistant" && !isUndefined(message.metadata)
	);
	if (assistant) {
		return assistant;
	}

	return turn.messages.findLast(
		(message) => message.role === "user" && !isUndefined(message.metadata)
	);
};

const resolveTurnFooterMessage = (
	turn: SessionTurn,
	nextTurn: SessionTurn | undefined
): SessionMessage | undefined => {
	const current = resolveTurnMetadataMessage(turn);
	if (!current) {
		return;
	}

	if (!nextTurn) {
		return current;
	}

	const nextMetadataMessage = resolveTurnMetadataMessage(nextTurn);
	if (
		!nextMetadataMessage ||
		resolveTurnMetadataSignature(current) !==
			resolveTurnMetadataSignature(nextMetadataMessage)
	) {
		return current;
	}

	return;
};

export const groupMessagesBySessionTurn = (
	messages: SessionMessage[]
): SessionTurn[] => {
	const turns: SessionTurn[] = [];
	const turnsByUserMessageId = new Map<string, SessionTurn>();
	let currentTurn: SessionTurn | null = null;

	for (const message of messages) {
		// A user message that joined a running Agent Turn does not open one: it
		// belongs to the turn it was delivered into, so the transcript reads as
		// the turn the model actually ran.
		const joinedTurnId = message.metadata?.joinedTurnId;
		if (
			isNull(currentTurn) ||
			(message.role === "user" && isUndefined(joinedTurnId))
		) {
			currentTurn = { id: message.id, messages: [message] };
			turns.push(currentTurn);
			if (message.role === "user") {
				turnsByUserMessageId.set(message.id, currentTurn);
			}
			continue;
		}

		const sourceTurn = isUndefined(message.metadata?.sourceUserMessageId)
			? undefined
			: turnsByUserMessageId.get(message.metadata.sourceUserMessageId);
		(sourceTurn ?? currentTurn).messages.push(message);
	}

	return turns;
};
const canRetryUser = (
	messages: readonly SessionMessage[],
	userIndex: number
): boolean => {
	const attemptMessages = getSessionAttemptMessages(messages, userIndex);
	if (hasCompletedToolArtifact(attemptMessages)) {
		return false;
	}
	const latestAssistant = attemptMessages.findLast(
		(message) => message.role === "assistant"
	);
	return (
		isUndefined(latestAssistant) ||
		latestAssistant.metadata?.interrupted === true ||
		!isUndefined(latestAssistant.metadata?.terminalOutcome)
	);
};

/**
 * Returns the latest logical user message whose attempt can be retried. An
 * attempt ends at the next user message — the message that opened its turn,
 * never one that joined a running turn — because retry replays the turn from
 * the input that started it. Completed Tool Calls suppress replay because
 * repeating them can duplicate side effects. Persisted failure outcomes remain
 * explicitly retryable.
 */
export const resolveRetryMessageId = (
	messages: readonly SessionMessage[]
): SessionMessageId | undefined => {
	const failedSteering = messages.find(
		(message) =>
			message.role === "user" &&
			message.metadata?.submissionStatus === "failed" &&
			message.metadata.submissionId !== undefined
	);
	if (failedSteering !== undefined) {
		return failedSteering.id;
	}
	const userIndex = messages.findLastIndex(
		(message, index) =>
			message.role === "user" &&
			isUndefined(message.metadata?.joinedTurnId) &&
			canRetryUser(messages, index)
	);
	return userIndex === -1 ? undefined : messages[userIndex]?.id;
};

export const resolveSessionTurnFooterMessages = (
	turns: SessionTurn[]
): Map<string, SessionMessage> => {
	const footers = new Map<string, SessionMessage>();

	for (const [index, turn] of turns.entries()) {
		const footerMessage = resolveTurnFooterMessage(turn, turns[index + 1]);
		if (footerMessage) {
			footers.set(turn.id, footerMessage);
		}
	}

	return footers;
};
