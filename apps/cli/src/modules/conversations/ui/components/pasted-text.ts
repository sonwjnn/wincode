export type PastedText = { token: string; text: string };
export type TrackedPastedText = PastedText & { end: number; start: number };

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

/** Expand markers from right to left; offsets are UTF-16, never terminal columns. */
export const expandPastedText = (
	text: string,
	markers: readonly PastedText[]
): string => {
	const occurrences: Array<{ end: number; start: number; value: string }> = [];
	let cursor = 0;
	for (const marker of markers) {
		const start = text.indexOf(marker.token, cursor);
		if (start === -1) {
			continue;
		}
		occurrences.push({
			end: start + marker.token.length,
			start,
			value: marker.text,
		});
		cursor = start + marker.token.length;
	}
	return occurrences
		.toReversed()
		.reduce(
			(result, occurrence) =>
				result.slice(0, occurrence.start) +
				occurrence.value +
				result.slice(occurrence.end),
			text
		);
};

/** Expand extmark-backed markers without replacing literal lookalikes. */
export const expandTrackedPastedText = (
	text: string,
	markers: readonly TrackedPastedText[]
): string =>
	markers
		.toSorted((left, right) => right.start - left.start)
		.reduce(
			(result, marker) =>
				result.slice(0, marker.start) + marker.text + result.slice(marker.end),
			text
		);
