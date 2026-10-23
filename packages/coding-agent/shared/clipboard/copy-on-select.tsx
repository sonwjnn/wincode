import type { Selection } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect } from "react";
import { useToast } from "../providers/toast/toast-provider";
import type { ToastOptions } from "../providers/toast/types";
import {
	type ClipboardTextRenderable,
	ClipboardTooLargeError,
	type ClipboardWriter,
} from "./clipboard";
import { useClipboard } from "./provider";

export type HandleSelectionOptions = {
	clipboard: ClipboardWriter;
	enabled?: boolean;
	focusedRenderable?: ClipboardTextRenderable;
	show: (options: ToastOptions) => void;
};

type SelectionText = Pick<Selection, "getSelectedText" | "isStart"> & {
	readonly selectedRenderables?: readonly ClipboardTextRenderable[];
};

const resolveClipboardText = (
	selection: SelectionText,
	focusedRenderable: ClipboardTextRenderable | undefined
): string => {
	const text = selection.getSelectedText();
	if (!focusedRenderable) {
		return text;
	}
	const isSelected =
		selection.selectedRenderables?.some(
			(renderable) => renderable.id === focusedRenderable.id
		) === true;
	const transform = focusedRenderable.getClipboardText;
	return isSelected && transform
		? transform.call(focusedRenderable, text)
		: text;
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
}

export type CopyOnSelectProps = {
	enabled: boolean;
};

export function CopyOnSelect({ enabled }: CopyOnSelectProps) {
	const renderer = useRenderer();
	const clipboard = useClipboard();
	const toast = useToast();

	useEffect(() => {
		const onSelection = (selection: Selection) => {
			void handleSelection(selection, {
				clipboard,
				enabled,
				focusedRenderable: renderer.currentFocusedRenderable ?? undefined,
				show: toast.show,
			});
		};
		renderer.on("selection", onSelection);
		return () => {
			renderer.off("selection", onSelection);
		};
	}, [enabled, renderer, toast.show, clipboard]);

	return null;
}
