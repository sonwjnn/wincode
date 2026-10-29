import type { TrackedSubmissionIntent } from "@/modules/commands/submission-resolution";
import { resolveTextEditRegion } from "@/modules/sessions/attachments";
import { getLeadingTrimLength } from "@/shared/utils/text-ranges";
import { isWhitespace } from "./triggers";

/** A composer selection tracked by the marker it inserted into the text. */
export type TrackedCommandSelection = TrackedSubmissionIntent;

export const normalizeCommandSelectionsForTrimmedText = (
	rawText: string,
	selections: readonly TrackedCommandSelection[]
): TrackedCommandSelection[] => {
	const text = rawText.trim();
	const leadingTrim = getLeadingTrimLength(rawText);
	return selections.flatMap((selection) => {
		const start = selection.start - leadingTrim;
		const end = selection.end - leadingTrim;
		return start >= 0 &&
			end <= text.length &&
			text.slice(start, end) === selection.marker
			? [{ ...selection, end, start }]
			: [];
	});
};

/**
 * The trailing separator a completed invocation needs. The namespace chooser
 * reopens without one, and a trigger that already sits before whitespace keeps
 * that single space instead of gaining a second.
 */
export const commandInsertionSeparator = (
	text: string,
	end: number,
	reopen: boolean
): string => (reopen || isWhitespace(text[end]) ? "" : " ");

/**
 * Shifts every tracking range through a text edit and drops each selection
 * whose marker no longer stands at the shifted range, so a tracked intent
 * always matches the marker the user can still see.
 */
export const applyTextEdit = (
	selections: readonly TrackedCommandSelection[],
	previousText: string,
	nextText: string
): TrackedCommandSelection[] => {
	if (previousText === nextText) {
		return [...selections];
	}
	const { prefixLength } = resolveTextEditRegion(previousText, nextText);
	const delta = nextText.length - previousText.length;
	return selections.flatMap((selection) => {
		let { start, end } = selection;
		// An edit before the marker can repeat its opening characters and still
		// leave the marker intact, so the shifted marker check below decides
		// instead of the prefix/suffix split alone.
		if (end > prefixLength) {
			start += delta;
			end += delta;
		}
		if (
			start < 0 ||
			end > nextText.length ||
			nextText.slice(start, end) !== selection.marker
		) {
			return [];
		}
		return [{ ...selection, end, start }];
	});
};
