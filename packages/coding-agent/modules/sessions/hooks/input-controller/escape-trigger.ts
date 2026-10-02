import { expandRangeOverNeighbouringSpace } from "@/shared/utils/text-ranges";
import type { ActiveTrigger } from "./triggers";

export type EscapeTriggerResult = {
	text: string;
	cursorOffset: number | null;
};

/**
 * Removes a trigger and reports where the cursor lands. A completed command
 * trigger also drops one neighbouring space so the surrounding prose stays
 * single-spaced; the trigger itself ends at the cursor, so text the user typed
 * after it survives. File mentions keep their exact range.
 */
export const removeTriggerText = (
	text: string,
	trigger: ActiveTrigger
): EscapeTriggerResult => {
	const { start, end } =
		trigger.kind === "command"
			? expandRangeOverNeighbouringSpace(text, trigger)
			: trigger;
	return {
		text: `${text.slice(0, start)}${text.slice(end)}`,
		cursorOffset: start,
	};
};
