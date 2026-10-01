export type TextReplacementRange = Readonly<{
	end: number;
	start: number;
	text: string;
}>;

export const replaceTextRanges = (
	text: string,
	ranges: readonly TextReplacementRange[]
): string =>
	ranges
		.toSorted((left, right) => right.start - left.start)
		.reduce(
			(result, range) =>
				result.slice(0, range.start) + range.text + result.slice(range.end),
			text
		);

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
