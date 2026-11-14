import type { SessionFilePart } from "../message";
import type { SessionAttachments } from "./session-attachments";

export type PromptHistoryEntry = {
	fileTokens?: Array<{ start: number; token: string }>;
	files: SessionFilePart[];
	pastedText?: Array<{ start: number; token: string; text: string }>;
	text: string;
};

/**
 * The prompts already sent in this workspace, for composer recall.
 *
 * It shares the Session storage connection but is not a Session storage facet:
 * the rows carry no `sessionId`, and `resetSessionData` keeps them because a
 * projection rebuild cannot recreate them. No facet therefore exposes
 * `clearPromptHistory`; nothing ever cleared it.
 */
export type PromptHistory = Readonly<{
	getPromptHistory: () => Promise<PromptHistoryEntry[]>;
	recordPrompt: (entry: PromptHistoryEntry) => Promise<void>;
}>;

/**
 * What the composer records a prompt with: the two history operations, plus the
 * attachment externalization that turns a prompt's file parts into blob
 * references before they are written.
 */
export type PromptHistoryStore = PromptHistory &
	Pick<SessionAttachments, "externalizeAttachments">;
