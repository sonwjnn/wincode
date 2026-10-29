import {
	findTextOccurrences,
	getLeadingTrimLength,
	type OffsetRange,
	rebaseTextRangesWithin,
	replaceTextRanges,
	type TextReplacementRange,
} from "@/shared/utils/text-ranges";

export type PastedText = { token: string; text: string };
export type PastedTextMarker = PastedText & { start: number };

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
	const leadingTrim = getLeadingTrimLength(rawText);
	return pastedTexts.map((pasted) => ({
		...pasted,
		start: pasted.start - leadingTrim,
	}));
};

/** Rebases valid tracked marker ranges onto the trimmed visible composition. */
export const restorePastedTextMarkers = (
	text: string,
	markers: readonly (PastedText & { start?: number })[]
): PastedTextMarker[] => {
	const occurrencesByToken = new Map<string, number[]>();
	const markerCountsByToken = new Map<string, number>();
	const missingByToken = new Map<string, number[]>();
	for (const [index, marker] of markers.entries()) {
		markerCountsByToken.set(
			marker.token,
			(markerCountsByToken.get(marker.token) ?? 0) + 1
		);
		if (!occurrencesByToken.has(marker.token)) {
			occurrencesByToken.set(
				marker.token,
				findTextOccurrences(text, marker.token)
			);
		}
		if (marker.start === undefined) {
			const indices = missingByToken.get(marker.token) ?? [];
			indices.push(index);
			missingByToken.set(marker.token, indices);
		}
	}
	const inferredStarts = new Map<number, number>();
	for (const [token, indices] of missingByToken) {
		const occurrences = occurrencesByToken.get(token) ?? [];
		const [index] = indices;
		const [start] = occurrences;
		if (
			markerCountsByToken.get(token) === 1 &&
			indices.length === 1 &&
			occurrences.length === 1 &&
			index !== undefined &&
			start !== undefined
		) {
			inferredStarts.set(index, start);
		}
	}
	return markers.flatMap((marker, index) => {
		const start = marker.start ?? inferredStarts.get(index);
		return typeof start === "number" &&
			Number.isInteger(start) &&
			start >= 0 &&
			text.slice(start, start + marker.token.length) === marker.token
			? [{ ...marker, start }]
			: [];
	});
};

export const normalizePastedTextRangesForTrimmedText = (
	rawText: string,
	pastedTexts: readonly PastedTextMarker[]
): PastedTextMarker[] => {
	const text = rawText.trim();
	return shiftPastedTextRangesForTrimmedText(rawText, pastedTexts).flatMap(
		(pasted) =>
			pasted.start >= 0 &&
			text.slice(pasted.start, pasted.start + pasted.token.length) ===
				pasted.token
				? [pasted]
				: []
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
		const { start } = marker;
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
