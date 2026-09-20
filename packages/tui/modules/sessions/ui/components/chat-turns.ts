import type { SessionMessageId } from "@wincode/agent-core";
import { normalizeChatModelSelection } from "@wincode/ai/models";
import { isNull, isString, isUndefined } from "@wincode/runtime-utils";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "@/modules/sessions/session-retry";
import { isDelegatedSessionMessageId } from "@/modules/sessions/storage/session-record";

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
	const variant = metadata.variant ?? "";

	return `${agent}|${modelKey}|${variant}|${interrupted}`;
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

	const next = resolveTurnMetadataMessage(nextTurn);
	if (
		!next ||
		resolveTurnMetadataSignature(current) !== resolveTurnMetadataSignature(next)
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
const canRetryPrimaryUser = (
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
 * Returns the latest logical primary user message whose attempt can be retried.
 * An attempt ends at the next primary user — the message that opened its turn,
 * never one that joined a running turn — because retry replays the turn from
 * the input that started it. Completed Tool Calls suppress replay because
 * repeating them can duplicate side effects. Persisted failure outcomes remain
 * explicitly retryable.
 */
export const resolveRetryMessageId = (
	messages: readonly SessionMessage[]
): SessionMessageId | undefined => {
	const primaryMessages = messages.filter(
		({ id }) => !isDelegatedSessionMessageId(id)
	);
	const userIndex = primaryMessages.findLastIndex(
		(message, index) =>
			message.role === "user" &&
			isUndefined(message.metadata?.joinedTurnId) &&
			canRetryPrimaryUser(primaryMessages, index)
	);
	return userIndex === -1 ? undefined : primaryMessages[userIndex]?.id;
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
