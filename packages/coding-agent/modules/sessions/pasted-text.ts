import {
	replaceTextRanges,
	type TextReplacementRange,
} from "@/shared/utils/text-ranges";

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
