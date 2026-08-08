import { detectFileMentionAtCursor } from "@/modules/file-mentions";

export type CommandTrigger = {
	end: number;
	kind: "command";
	query: string;
	start: number;
};

export type FileMentionTrigger = {
	kind: "file-mention";
	query: string;
	start: number;
	end: number;
};

export type ActiveTrigger = CommandTrigger | FileMentionTrigger;

export const detectCommandTrigger = (
	text: string,
	cursorOffset = text.length
): CommandTrigger | null => {
	const prefix = text.slice(0, cursorOffset);
	const slashIndex = prefix.lastIndexOf("/");
	if (slashIndex === -1 || prefix.slice(0, slashIndex).trim() !== "") {
		return null;
	}

	const query = prefix.slice(slashIndex + 1);

	return { end: cursorOffset, kind: "command", query, start: 0 };
};

export const detectTrigger = (
	text: string,
	cursorOffset: number
): ActiveTrigger | null => {
	const commandTrigger = detectCommandTrigger(text, cursorOffset);
	if (commandTrigger) {
		return commandTrigger;
	}

	const fileMentionTrigger = detectFileMentionAtCursor(text, cursorOffset);
	if (!fileMentionTrigger) {
		return null;
	}

	return { kind: "file-mention", ...fileMentionTrigger };
};
