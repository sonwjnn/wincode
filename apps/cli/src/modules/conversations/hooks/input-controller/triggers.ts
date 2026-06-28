import { detectFileMentionAtCursor } from "../../utils/file-mentions/mention-grammar";

export type CommandTrigger = {
	kind: "command";
	query: string;
};

export type FileMentionTrigger = {
	kind: "file-mention";
	query: string;
	start: number;
	end: number;
};

export type ActiveTrigger = CommandTrigger | FileMentionTrigger;

export const detectCommandTrigger = (text: string): CommandTrigger | null => {
	if (!text.startsWith("/")) {
		return null;
	}

	const query = text.slice(1);

	if (query.includes(" ")) {
		return null;
	}

	return { kind: "command", query };
};

export const detectTrigger = (
	text: string,
	cursorOffset: number
): ActiveTrigger | null => {
	const commandTrigger = detectCommandTrigger(text);
	if (commandTrigger && cursorOffset === text.length) {
		return commandTrigger;
	}

	const fileMentionTrigger = detectFileMentionAtCursor(text, cursorOffset);
	if (!fileMentionTrigger) {
		return null;
	}

	return { kind: "file-mention", ...fileMentionTrigger };
};
