export type FileMentionRange = {
	end: number;
	query: string;
	start: number;
};

export type FileMentionReplacement = {
	cursorOffset: number;
	text: string;
};

type RemovedCharacter = {
	index: number;
};

const MENTION_BOUNDARY_RE = /[\w.-]/u;
const MENTION_QUERY_INVALID_RE = /[^\w./-]/u;
const MENTION_SPACE_BLOCKING_RE = /[,.;:!?)]/u;
const MENTION_TRAILING_SLASH_RE = /\/+$/u;
const WHITESPACE_RE = /\s/u;
const WORD_CHAR_RE = /\w/u;

const isQuotedMention = (text: string, atIndex: number) => {
	const quoteChars = ['"', "'", "`"] as const;

	for (const quote of quoteChars) {
		const openingQuoteIndex = text.lastIndexOf(quote, atIndex - 1);
		if (openingQuoteIndex === -1) {
			continue;
		}

		const previousChar =
			openingQuoteIndex === 0 ? "" : (text[openingQuoteIndex - 1] ?? "");
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

const canStartFileMention = (text: string, atIndex: number) => {
	if (isQuotedMention(text, atIndex)) {
		return false;
	}

	const prevChar = atIndex === 0 ? "" : (text[atIndex - 1] ?? "");
	return !(prevChar && MENTION_BOUNDARY_RE.test(prevChar));
};

const getMentionEnd = (text: string, cursorOffset: number) => {
	const afterCursor = text.slice(cursorOffset);
	const invalidAfterCursorIndex = afterCursor.search(MENTION_QUERY_INVALID_RE);

	return invalidAfterCursorIndex === -1
		? text.length
		: cursorOffset + invalidAfterCursorIndex;
};

export const normalizeFileMentionPath = (mentionPath: string) => {
	const normalized = mentionPath.replace(MENTION_TRAILING_SLASH_RE, "");
	return normalized.length > 0 ? normalized : null;
};

export const detectFileMentionAtCursor = (
	text: string,
	cursorOffset: number
): FileMentionRange | null => {
	const beforeCursor = text.slice(0, cursorOffset);
	const atIndex = beforeCursor.lastIndexOf("@");
	if (atIndex === -1 || !canStartFileMention(text, atIndex)) {
		return null;
	}

	const query = text.slice(atIndex + 1, cursorOffset);
	if (MENTION_QUERY_INVALID_RE.test(query)) {
		return null;
	}

	return {
		end: getMentionEnd(text, cursorOffset),
		query,
		start: atIndex,
	};
};

export const findFileMentionRanges = (text: string): FileMentionRange[] => {
	const ranges: FileMentionRange[] = [];
	let searchIndex = 0;

	while (searchIndex < text.length) {
		const atIndex = text.indexOf("@", searchIndex);
		if (atIndex === -1) {
			break;
		}

		searchIndex = atIndex + 1;
		if (!canStartFileMention(text, atIndex)) {
			continue;
		}

		const end = getMentionEnd(text, atIndex + 1);
		const query = text.slice(atIndex + 1, end);
		if (!(query && normalizeFileMentionPath(query))) {
			continue;
		}

		ranges.push({ end, query, start: atIndex });
	}

	return ranges;
};

export const replaceFileMentionRange = (
	text: string,
	range: FileMentionRange,
	replacement: string
) => `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`;

const getRemovedCharacter = (
	previousText: string,
	nextText: string
): RemovedCharacter | null => {
	if (previousText.length !== nextText.length + 1) {
		return null;
	}

	let index = 0;
	while (index < nextText.length && previousText[index] === nextText[index]) {
		index += 1;
	}

	if (previousText.slice(index + 1) !== nextText.slice(index)) {
		return null;
	}

	return { index };
};

export const deleteFileMentionAfterTrailingCharacterDelete = (
	previousText: string,
	nextText: string,
	cursorOffset: number
): FileMentionReplacement | null => {
	const removedCharacter = getRemovedCharacter(previousText, nextText);
	if (!removedCharacter || removedCharacter.index !== cursorOffset) {
		return null;
	}

	for (const range of findFileMentionRanges(previousText)) {
		if (removedCharacter.index !== range.end - 1) {
			continue;
		}

		return {
			cursorOffset: range.start,
			text: replaceFileMentionRange(previousText, range, ""),
		};
	}

	return null;
};

export const applyFileMentionReplacement = (
	text: string,
	range: FileMentionRange,
	replacement: string
): FileMentionReplacement => {
	const nextChar = text[range.end] ?? "";
	const shouldUseExistingSpace = WHITESPACE_RE.test(nextChar);
	const shouldInsertSpace = !(
		nextChar &&
		(shouldUseExistingSpace || MENTION_SPACE_BLOCKING_RE.test(nextChar))
	);
	const replacementText = `${replacement}${shouldInsertSpace ? " " : ""}`;

	return {
		cursorOffset:
			range.start + replacementText.length + (shouldUseExistingSpace ? 1 : 0),
		text: replaceFileMentionRange(text, range, replacementText),
	};
};
