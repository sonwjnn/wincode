import type { DialogMargin, DialogPadding } from "./types";

/** Default dialog shell spacing; individual dialogs can override each side. */
export const DEFAULT_DIALOG_PADDING: Required<DialogPadding> = {
	bottom: 1,
	left: 0,
	right: 0,
	top: 1,
};

export const DEFAULT_DIALOG_CONTENT_MARGIN: DialogMargin = {
	left: 4,
	right: 4,
};

export const DEFAULT_DIALOG_LIST_ITEM_MARGIN: DialogMargin = {
	left: 1,
	right: 1,
};
