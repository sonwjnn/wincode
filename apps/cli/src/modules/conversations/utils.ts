import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type ModeType,
	normalizeChatModelSelection,
} from "@wincode/ai";
import type { ConversationSession } from "./storage/conversation-store";

export const shouldAutoStartAssistantTurn = (
	autoStart: boolean,
	initialPrompt: string,
	lastMessage: CodingAgentUIMessage | undefined
): boolean =>
	autoStart &&
	initialPrompt.trim().length === 0 &&
	lastMessage?.role === "user";

export const getLatestChatConfig = (
	messages: CodingAgentUIMessage[]
): { mode: ModeType; model: ChatModelSelection } | undefined => {
	const metadata = messages.findLast(
		(message) => message.metadata?.mode && message.metadata.model
	)?.metadata;
	if (!(metadata?.mode && metadata.model)) {
		return;
	}

	const model = normalizeChatModelSelection(metadata.model);
	return model ? { mode: metadata.mode, model } : undefined;
};

export const getMostRecentSession = (
	sessions: ConversationSession[]
): ConversationSession | undefined =>
	sessions.reduce<ConversationSession | undefined>((latest, session) => {
		if (!latest) {
			return session;
		}

		const sessionTime = session.lastMessageAt ?? session.createdAt;
		const latestTime = latest.lastMessageAt ?? latest.createdAt;
		return sessionTime > latestTime ? session : latest;
	}, undefined);
