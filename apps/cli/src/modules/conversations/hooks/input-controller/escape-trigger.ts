import type { ActiveTrigger } from "./triggers";

export type EscapeTriggerResult = {
	text: string;
	cursorOffset: number | null;
};

export const removeTriggerText = (
	text: string,
	trigger: ActiveTrigger
): EscapeTriggerResult => {
	if (trigger.kind === "command") {
		return { text: "", cursorOffset: null };
	}

	return {
		text: `${text.slice(0, trigger.start)}${text.slice(trigger.end)}`,
		cursorOffset: trigger.start,
	};
};
