import { omitUndefined } from "@wincode/utils";
import {
	type OffsetRange,
	rebaseTextRangesWithin,
	replaceTextRanges,
	type TextReplacementRange,
} from "@/shared/utils/text-ranges";

export type PastedText = { token: string; text: string };
export type PastedTextMarker = PastedText & { start?: number };
export type TrackedPastedText = PastedText & { start: number };

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

export const shiftPastedTextRangesForTrimmedText = (
	rawText: string,
	pastedTexts: readonly PastedTextMarker[]
): PastedTextMarker[] => {
	const leadingTrim = rawText.length - rawText.trimStart().length;
	return pastedTexts.map(({ start, ...pasted }) => ({
		...pasted,
		...omitUndefined({
			start: start === undefined ? undefined : start - leadingTrim,
		}),
	}));
};

/** Rebases valid tracked marker ranges onto the trimmed visible composition. */
export const normalizePastedTextRangesForTrimmedText = (
	rawText: string,
	pastedTexts: readonly TrackedPastedText[]
): TrackedPastedText[] => {
	const text = rawText.trim();
	return shiftPastedTextRangesForTrimmedText(rawText, pastedTexts).flatMap(
		(pasted) => {
			if (pasted.start === undefined) {
				return [];
			}
			return pasted.start >= 0 &&
				text.slice(pasted.start, pasted.start + pasted.token.length) ===
					pasted.token
				? [{ ...pasted, start: pasted.start }]
				: [];
		}
	);
};

/** Expands each composition marker once while preserving the remaining offsets. */
export const expandPastedText = (
	text: string,
	markers: readonly PastedTextMarker[]
): string => {
	const occurrences: TextReplacementRange[] = [];
	let cursor = 0;
	for (const marker of markers) {
		const start = marker.start ?? text.indexOf(marker.token, cursor);
		if (
			start < cursor ||
			text.slice(start, start + marker.token.length) !== marker.token
		) {
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

/** Expands only the tracked markers fully covered by the selected range. */
export const expandPastedTextInRange = (
	text: string,
	selection: OffsetRange,
	markers: readonly TextReplacementRange[]
): string =>
	replaceTextRanges(text, rebaseTextRangesWithin(markers, selection));

/** Removes paste markers whose payload cannot be rebuilt from restored text. */
export const stripPastedTextTokens = (text: string): string =>
	text.replaceAll(PASTED_TEXT_TOKEN_PATTERN, "");
