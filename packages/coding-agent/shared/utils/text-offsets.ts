export type OffsetRange = Readonly<{ end: number; start: number }>;

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
