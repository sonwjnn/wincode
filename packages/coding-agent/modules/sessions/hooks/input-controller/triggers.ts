import { detectFileMentionAtCursor } from "@/modules/file-mentions";

const WHITESPACE_PATTERN = /\s/u;

/**
 * Where the slash stands: `root` opens the full command menu at the start of
 * the prompt, `skill` opens the Skill list on a `/` token inside prose.
 */
export type CommandTriggerMode = "root" | "skill";

export type CommandTrigger = {
	end: number;
	kind: "command";
	mode: CommandTriggerMode;
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

const isWhitespace = (character: string | undefined): boolean =>
	character !== undefined && WHITESPACE_PATTERN.test(character);

export const detectCommandTrigger = (
	text: string,
	cursorOffset = text.length
): CommandTrigger | null => {
	const prefix = text.slice(0, cursorOffset);
	const slashIndex = prefix.lastIndexOf("/");
	if (slashIndex === -1) {
		return null;
	}

	const query = prefix.slice(slashIndex + 1);
	if (WHITESPACE_PATTERN.test(query)) {
		return null;
	}

	const before = text.slice(0, slashIndex);
	const isRoot = before.trim() === "";
	// A `/` inside a token — a URL, path, or word — is not a command trigger.
	if (!(isRoot || isWhitespace(before.at(-1)))) {
		return null;
	}

	let end = slashIndex + 1;
	while (end < text.length && !isWhitespace(text[end])) {
		end += 1;
	}

	return {
		end,
		kind: "command",
		mode: isRoot ? "root" : "skill",
		query,
		start: isRoot ? 0 : slashIndex,
	};
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
