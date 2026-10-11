import type { DialogConfig } from "./types";

/** Shared spacing from the established dialog layout; each dialog can override either value. */
export const DEFAULT_DIALOG_CONFIG = {
	padding: { bottom: 1, left: 0, right: 0, top: 1 },
	titleMargin: { bottom: 0, left: 4, right: 4, top: 0 },
} as const satisfies Pick<DialogConfig, "padding" | "titleMargin">;

export const DEFAULT_DIALOG_CONTENT_MARGIN_X = 4;
export const DEFAULT_DIALOG_LIST_ITEM_MARGIN_X = 1;
