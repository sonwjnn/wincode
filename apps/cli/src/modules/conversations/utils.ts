import type { CodingAgentUIMessage, SkillContext } from "@wincode/ai";
import type { FileUIPart } from "@wincode/ai/client";
import type { ConversationSession } from "./storage/conversation-store";

export const shouldAutoStartAssistantTurn = (
	autoStart: boolean,
	initialPrompt: string,
	lastMessage: CodingAgentUIMessage | undefined
): boolean =>
	autoStart &&
	initialPrompt.trim().length === 0 &&
	lastMessage?.role === "user";

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
	files: FileUIPart[];
	text: string;
	skill?: SkillContext;
};
