import type { CommandSelectionIntent } from "@/modules/commands/command-controller";
import { resolveTextEditRegion } from "@/modules/sessions/attachments";

/** A composer selection tracked by the marker it inserted into the text. */
export type TrackedCommandSelection = Readonly<{
	end: number;
	kind: CommandSelectionIntent["kind"];
	marker: string;
	name: string;
	start: number;
}>;

/**
 * Shifts every tracking range through a text edit and drops each selection
 * whose marker the edit touched, so a tracked intent always matches the marker
 * the user can still see.
 */
export const applyTextEdit = (
	selections: readonly TrackedCommandSelection[],
	previousText: string,
	nextText: string
): TrackedCommandSelection[] => {
	if (previousText === nextText) {
		return [...selections];
	}
	const { prefixLength, suffixLength } = resolveTextEditRegion(
		previousText,
		nextText
	);
	const delta = nextText.length - previousText.length;
	return selections.flatMap((selection) => {
		let { start, end } = selection;
		if (end > prefixLength) {
			if (start < previousText.length - suffixLength) {
				return [];
			}
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
