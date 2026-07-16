import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type ModelVariant,
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
):
	| { mode: ModeType; model: ChatModelSelection; variant?: ModelVariant }
	| undefined => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const metadata = messages[index]?.metadata;
		if (!(metadata?.mode && metadata.model)) {
			continue;
		}

		const model = normalizeChatModelSelection(metadata.model);
		if (!model) {
			continue;
		}

		return { mode: metadata.mode, model, variant: metadata.variant };
	}

	return;
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
