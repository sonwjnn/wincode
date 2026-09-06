import { normalizeChatModelSelection } from "@wincode/ai/models";
import type { ConversationMessage } from "@/modules/conversations/message";
import {
	isConversationToolPart,
	isTerminalConversationToolPart,
} from "@/modules/conversations/message";

export type ConversationTurn = {
	id: string;
	messages: ConversationMessage[];
};

export const resolveTurnMetadataSignature = (
	message: ConversationMessage
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
	} else if (typeof metadata.model === "string") {
		modelKey = metadata.model;
	} else if (metadata.model) {
		modelKey = `${metadata.model.providerId}/${metadata.model.modelId}`;
	}
	const interrupted = metadata.interrupted === true ? "1" : "0";
	const variant = metadata.variant ?? "";

	return `${agent}|${modelKey}|${variant}|${interrupted}`;
};

const resolveTurnFooterMessage = (
	turn: ConversationTurn,
	nextTurn: ConversationTurn | undefined
): ConversationMessage | undefined => {
	const current = [...turn.messages]
		.reverse()
		.find(
			(message) =>
				message.role === "assistant" && message.metadata !== undefined
		);
	if (!current) {
		if (nextTurn) {
			return;
		}

		return [...turn.messages]
			.reverse()
			.find(
				(message) => message.role === "user" && message.metadata !== undefined
			);
	}

	if (!nextTurn) {
		return current;
	}

	const next = [...nextTurn.messages]
		.reverse()
		.find(
			(message) =>
				message.role === "assistant" && message.metadata !== undefined
		);
	if (!next) {
		return current;
	}

	if (
		resolveTurnMetadataSignature(current) === resolveTurnMetadataSignature(next)
	) {
		return;
	}

	return current;
};

export const groupMessagesByConversationTurn = (
	messages: ConversationMessage[]
): ConversationTurn[] => {
	const turns: ConversationTurn[] = [];
	let currentTurn: ConversationTurn | null = null;

	for (const message of messages) {
		if (message.role === "user" || currentTurn === null) {
			currentTurn = { id: message.id, messages: [message] };
			turns.push(currentTurn);
			continue;
		}

		currentTurn.messages.push(message);
	}

	return turns;
};
const canRetryPrimaryUser = (
	messages: readonly ConversationMessage[],
	userIndex: number
): boolean => {
	const nextUserIndex = messages.findIndex(
		(message, index) => index > userIndex && message.role === "user"
	);
	const attemptMessages = messages.slice(
		userIndex + 1,
		nextUserIndex === -1 ? undefined : nextUserIndex
	);
	if (
		attemptMessages.some(
			(message) =>
				message.role === "assistant" &&
				message.parts.some(
					(part) =>
						isConversationToolPart(part) && isTerminalConversationToolPart(part)
				)
		)
	) {
		return false;
	}
	const latestAssistant = attemptMessages.findLast(
		(message) => message.role === "assistant"
	);
	return (
		latestAssistant === undefined ||
		latestAssistant.metadata?.interrupted === true ||
		latestAssistant.metadata?.terminalOutcome !== undefined
	);
};

export const resolveRetryMessageId = (
	messages: readonly ConversationMessage[]
): string | undefined => {
	const primaryMessages = messages.filter(
		({ id }) => !id.startsWith("delegated-turn:")
	);
	const userIndex = primaryMessages.findLastIndex(
		(message, index) =>
			message.role === "user" && canRetryPrimaryUser(primaryMessages, index)
	);
	return userIndex === -1 ? undefined : primaryMessages[userIndex]?.id;
};

export const resolveConversationTurnFooterMessages = (
	turns: ConversationTurn[]
): Map<string, ConversationMessage> => {
	const footers = new Map<string, ConversationMessage>();

	for (const [index, turn] of turns.entries()) {
		const footerMessage = resolveTurnFooterMessage(turn, turns[index + 1]);
		if (footerMessage) {
			footers.set(turn.id, footerMessage);
		}
	}

	return footers;
};
