export type OffsetRange = Readonly<{ end: number; start: number }>;

export type TextReplacementRange = Readonly<OffsetRange & { text: string }>;

/** Splices each range's replacement text into the original, right to left. */
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

/**
 * Shifts an offset by the net delta of every range that ends at or before it.
 * A range that straddles the offset leaves it unchanged.
 */
export const shiftOffsetThroughRanges = <Range extends OffsetRange>(
	offset: number,
	ranges: readonly Range[],
	deltaOf: (range: Range) => number
): number =>
	ranges.reduce(
		(mapped, range) => (range.end <= offset ? mapped + deltaOf(range) : mapped),
		offset
	);
