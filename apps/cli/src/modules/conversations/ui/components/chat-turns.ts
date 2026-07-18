import type { CodingAgentUIMessage } from "@wincode/ai";
import { normalizeChatModelSelection } from "@wincode/ai";

export type ConversationTurn = {
	id: string;
	messages: CodingAgentUIMessage[];
};

export const resolveTurnMetadataSignature = (
	message: CodingAgentUIMessage
): string | null => {
	const metadata = message.metadata;
	if (!metadata) {
		return null;
	}

	const mode = metadata.mode ?? "";
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

	return `${mode}|${modelKey}|${variant}|${interrupted}`;
};

const resolveTurnFooterMessage = (
	turn: ConversationTurn,
	nextTurn: ConversationTurn | undefined
): CodingAgentUIMessage | undefined => {
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
	messages: CodingAgentUIMessage[]
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
): Map<string, CodingAgentUIMessage> => {
	const footers = new Map<string, CodingAgentUIMessage>();

	for (const [index, turn] of turns.entries()) {
		const footerMessage = resolveTurnFooterMessage(turn, turns[index + 1]);
		if (footerMessage) {
			footers.set(turn.id, footerMessage);
		}
	}

	return footers;
};
