import type { SkillContext } from "@wincode/skills";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { SessionSubmissionComposition } from "@/modules/sessions/session-operation";
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
	/**
	 * The visible composition the composer held — its text with attachment and
	 * pasted-text markers, those attachments, and the pasted text behind the
	 * markers — so a submission accepted while the session is busy can be
	 * recalled exactly as it was written.
	 */
	composition: SessionSubmissionComposition;
};
