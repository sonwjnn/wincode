import type { SkillContext } from "@wincode/skills";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { Session } from "./storage/session-store";

export const getMostRecentSession = (
	sessions: Session[]
): Session | undefined =>
	sessions.reduce<Session | undefined>((latest, session) => {
		if (!latest) {
			return session;
		}

		const sessionTime = session.lastMessageAt ?? session.createdAt;
		const latestTime = latest.lastMessageAt ?? latest.createdAt;
		return sessionTime > latestTime ? session : latest;
	}, undefined);

export type ChatPromptSubmission = {
	files: SessionFilePart[];
	text: string;
	skill?: SkillContext;
};
