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

export type FileMentionReplacement = {
	cursorOffset: number;
	text: string;
};

export type ActiveTrigger = CommandTrigger | FileMentionTrigger;

const MENTION_BOUNDARY_RE = /[\w.-]/u;
const MENTION_QUERY_INVALID_RE = /[^\w./-]/u;
const WORD_CHAR_RE = /\w/u;

const isQuotedMention = (text: string, atIndex: number) => {
	const quoteChars = ['"', "'", "`"] as const;

	for (const quote of quoteChars) {
		const openingQuoteIndex = text.lastIndexOf(quote, atIndex - 1);
		if (openingQuoteIndex === -1) {
			continue;
		}

		const previousChar =
			openingQuoteIndex === 0 ? "" : text[openingQuoteIndex - 1];
		const nextChar = text[openingQuoteIndex + 1] ?? "";
		const isWordApostrophe =
			quote === "'" &&
			WORD_CHAR_RE.test(previousChar) &&
			WORD_CHAR_RE.test(nextChar);
		if (isWordApostrophe) {
			continue;
		}

		const closingQuoteIndex = text.indexOf(quote, atIndex + 1);
		if (closingQuoteIndex !== -1) {
			return true;
		}
	}

	return false;
};

export const replaceFileMentionTrigger = (
	text: string,
	trigger: FileMentionTrigger,
	replacement: string
) => `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;

export const applyFileMentionReplacement = (
	text: string,
	trigger: FileMentionTrigger,
	replacement: string
): FileMentionReplacement => ({
	cursorOffset: trigger.start + replacement.length,
	text: replaceFileMentionTrigger(text, trigger, replacement),
});

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

	const beforeCursor = text.slice(0, cursorOffset);
	const atIndex = beforeCursor.lastIndexOf("@");
	if (atIndex === -1) {
		return null;
	}

	if (isQuotedMention(text, atIndex)) {
		return null;
	}

	const prevChar = atIndex === 0 ? "" : text[atIndex - 1];
	if (prevChar && MENTION_BOUNDARY_RE.test(prevChar)) {
		return null;
	}

	const query = text.slice(atIndex + 1, cursorOffset);
	if (MENTION_QUERY_INVALID_RE.test(query)) {
		return null;
	}

	const afterCursor = text.slice(cursorOffset);
	const invalidAfterCursorIndex = afterCursor.search(MENTION_QUERY_INVALID_RE);
	const end =
		invalidAfterCursorIndex === -1
			? text.length
			: cursorOffset + invalidAfterCursorIndex;

	return { kind: "file-mention", query, start: atIndex, end };
};
