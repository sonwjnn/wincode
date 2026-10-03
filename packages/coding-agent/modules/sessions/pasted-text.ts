import {
	replaceTextRanges,
	type TextReplacementRange,
} from "@/shared/utils/text-ranges";

export type PastedText = { token: string; text: string };

const PASTED_TEXT_TOKEN_PATTERN = /\[Pasted ~\d+ lines\]/gu;

export const normalizePastedText = (text: string): string =>
	text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

export const summarizePastedText = (value: string): PastedText | undefined => {
	const text = normalizePastedText(value);
	const trimmed = text.trim();
	if (trimmed.split("\n").length < 3 && trimmed.length <= 150) {
		return;
	}
	return { text, token: `[Pasted ~${trimmed.split("\n").length} lines]` };
};

/** Expands each composition marker once while preserving the remaining offsets. */
export const expandPastedText = (
	text: string,
	markers: readonly { token: string; text: string }[]
): string => {
	const occurrences: TextReplacementRange[] = [];
	let cursor = 0;
	for (const marker of markers) {
		const start = text.indexOf(marker.token, cursor);
		if (start === -1) {
			continue;
		}
		occurrences.push({
			end: start + marker.token.length,
			start,
			text: marker.text,
		});
		cursor = start + marker.token.length;
	}
	return replaceTextRanges(text, occurrences);
};

/** Removes paste markers whose payload cannot be rebuilt from restored text. */
export const stripPastedTextTokens = (text: string): string =>
	text.replaceAll(PASTED_TEXT_TOKEN_PATTERN, "");
