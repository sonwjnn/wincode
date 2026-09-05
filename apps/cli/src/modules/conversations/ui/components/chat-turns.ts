import { normalizeChatModelSelection } from "@wincode/ai/models";
import type { ConversationMessage } from "@/modules/conversations/message";

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
