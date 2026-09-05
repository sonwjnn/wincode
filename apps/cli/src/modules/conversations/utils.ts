import type { SkillContext } from "@wincode/skills";
import type {
	ConversationFilePart,
	ConversationMessage,
} from "@/modules/conversations/message";
import type { ConversationSession } from "./storage/conversation-store";

export const mergePendingInitialMessage = (
	messages: readonly ConversationMessage[],
	pendingMessage: ConversationMessage | undefined
): ConversationMessage[] => {
	if (
		pendingMessage === undefined ||
		messages.some(({ id }) => id === pendingMessage.id)
	) {
		return [...messages];
	}
	return [pendingMessage, ...messages];
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

export type ChatPromptSubmission = {
	files: ConversationFilePart[];
	text: string;
	skill?: SkillContext;
};
