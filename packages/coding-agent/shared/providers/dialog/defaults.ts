import type { DialogPadding } from "./types";

/** Default dialog shell spacing; individual dialogs can override each side. */
export const DEFAULT_DIALOG_PADDING: DialogPadding = {
	bottom: 1,
	left: 0,
	right: 0,
	top: 1,
};

/** Default title alignment; individual dialogs can override each side. */
export const DEFAULT_DIALOG_TITLE_MARGIN: DialogPadding = {
	bottom: 0,
	left: 4,
	right: 4,
	top: 0,
};

export const DEFAULT_DIALOG_CONTENT_MARGIN_X = 4;
export const DEFAULT_DIALOG_LIST_ITEM_MARGIN_X = 1;
