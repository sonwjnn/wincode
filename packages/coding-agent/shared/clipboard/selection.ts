import type { KeyEvent, Selection } from "@opentui/core";
import type { ToastOptions } from "../providers/toast/types";
import {
	ClipboardTooLargeError,
	type ClipboardWriter,
	getClipboardTextTransform,
} from "./clipboard";

export type SelectionText = Pick<
	Selection,
	"behavior" | "getSelectedText" | "isStart"
> & {
	readonly selectedRenderables?: readonly object[];
};

export type SelectionCopyOptions = {
	clipboard: ClipboardWriter;
	focusedRenderable?: object;
	show: (options: ToastOptions) => void;
};

export type HandleSelectionOptions = SelectionCopyOptions & {
	enabled?: boolean;
};

const isPlainCellClick = (selection: SelectionText): boolean =>
	selection.isStart && selection.behavior === "cell";

const resolveClipboardText = (
	selection: SelectionText,
	focusedRenderable: object | undefined
): string => {
	const text = selection.getSelectedText();
	if (!focusedRenderable) {
		return text;
	}
	const isSelected =
		selection.selectedRenderables?.includes(focusedRenderable) === true;
	const transform = isSelected
		? getClipboardTextTransform(focusedRenderable)
		: undefined;
	return transform ? transform(text) : text;
};

const resolveCopyText = (
	selection: SelectionText,
	focusedRenderable: object | undefined
): string | undefined => {
	// A plain cell click has no dragged range to copy. Word and line selections
	// from double/triple clicks are still copyable with the shortcut or right click.
	if (isPlainCellClick(selection)) {
		return;
	}
	const text = resolveClipboardText(selection, focusedRenderable);
	return text.length > 0 ? text : undefined;
};

const writeSelection = async (
	text: string,
	{ clipboard, show }: Pick<SelectionCopyOptions, "clipboard" | "show">
): Promise<void> => {
	try {
		const outcome = await clipboard.write(text);
		if (outcome === "copied") {
			show({ message: "Copied to clipboard", variant: "success", width: 30 });
		}
	} catch (error) {
		show({
			message:
				error instanceof ClipboardTooLargeError
					? "Selection is too large to copy."
					: "Failed to copy selection.",
			variant: "error",
		});
	}
};

/** Starts copying a selection; returns whether there was any text to copy. */
export const copySelection = (
	selection: SelectionText,
	options: SelectionCopyOptions
): boolean => {
	const text = resolveCopyText(selection, options.focusedRenderable);
	if (text === undefined) {
		return false;
	}
	void writeSelection(text, options);
	return true;
};

export async function handleSelection(
	selection: SelectionText,
	{ clipboard, enabled = true, focusedRenderable, show }: HandleSelectionOptions
): Promise<void> {
	if (!enabled) {
		return;
	}
	// Selection.isStart stays true until the pointer moves, so it is the
	// no-drag flag at the point the selection event fires. OpenCode gates its
	// copy-on-select on MouseEvent.isDragging for the same behavior.
	if (selection.isStart) {
		return;
	}
	const text = resolveClipboardText(selection, focusedRenderable);
	if (!text) {
		return;
	}
	await writeSelection(text, { clipboard, show });
}

export type SelectionKeyEvent = Pick<
	KeyEvent,
	"baseCode" | "ctrl" | "name" | "preventDefault" | "stopPropagation" | "super"
>;

export type SelectionKeyHost = {
	clearSelection: () => void;
	currentFocusedEditor?: { hasSelection: () => boolean } | null;
	currentFocusedRenderable?: object | null;
	getSelection: () => SelectionText | null;
};

export type SelectionKeyOptions = {
	clipboard: ClipboardWriter;
	show: (options: ToastOptions) => void;
};

// Kitty can report a non-Latin key name with a Latin base-layout C.
const KITTY_CTRL_C = 99;
const KITTY_CTRL_C_UPPER = 67;

/** Cmd+C on macOS, Ctrl+C elsewhere. */
export const isCopyShortcut = (
	event: SelectionKeyEvent,
	platform: NodeJS.Platform = process.platform
): boolean => {
	if (platform === "darwin") {
		return event.super === true && event.name === "c";
	}
	return (
		event.ctrl === true &&
		(event.name === "c" ||
			event.baseCode === KITTY_CTRL_C ||
			event.baseCode === KITTY_CTRL_C_UPPER)
	);
};

/**
 * Applies OpenCode's selection key contract. Cmd+C/Ctrl+C copies the selection
 * and keeps it visible, while absorbing the shortcut so Wincode's root exit
 * responder cannot treat it as an interrupt. Escape clears a real selection
 * and consumes the key so it cannot also interrupt; a plain cell click clears
 * without consuming, so the app still sees Escape. Any other key clears a
 * non-editor selection so typing resumes.
 */
export const handleSelectionKey = (
	event: SelectionKeyEvent,
	host: SelectionKeyHost,
	{ clipboard, show }: SelectionKeyOptions
): void => {
	const selection = host.getSelection();
	if (!selection) {
		return;
	}
	const editor = host.currentFocusedEditor;
	const editing =
		editor?.hasSelection() === true &&
		selection.selectedRenderables?.includes(editor) === true;

	if (isCopyShortcut(event)) {
		copySelection(selection, {
			clipboard,
			focusedRenderable: host.currentFocusedRenderable ?? undefined,
			show,
		});
		event.preventDefault();
		event.stopPropagation();
		return;
	}

	if (event.name === "escape") {
		const text = isPlainCellClick(selection) ? "" : selection.getSelectedText();
		host.clearSelection();
		if (!text) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		return;
	}

	if (editing) {
		return;
	}
	host.clearSelection();
};
