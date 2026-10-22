import type { Selection } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect } from "react";
import { useToast } from "../providers/toast/toast-provider";
import type { ToastOptions } from "../providers/toast/types";
import { ClipboardTooLargeError, type ClipboardWriter } from "./clipboard";
import { useClipboard } from "./provider";

export type HandleSelectionOptions = {
	enabled?: boolean;
};

type SelectionText = Pick<
	Selection,
	"getSelectedText" | "isStart" | "behavior"
>;

export async function handleSelection(
	selection: SelectionText,
	show: (options: ToastOptions) => void,
	clipboard: ClipboardWriter,
	{ enabled = true }: HandleSelectionOptions = {}
): Promise<void> {
	if (!enabled) {
		return;
	}
	// A plain click creates a one-cell selection; copying it would toast on every click.
	if (selection.isStart && selection.behavior === "cell") {
		return;
	}
	const text = selection.getSelectedText();
	if (!text) {
		return;
	}
	try {
		await clipboard.write(text);
		show({ message: "Copied to clipboard", variant: "success", width: 30 });
	} catch (error) {
		show({
			message:
				error instanceof ClipboardTooLargeError
					? error.message
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
			void handleSelection(selection, toast.show, clipboard, { enabled });
		};
		renderer.on("selection", onSelection);
		return () => {
			renderer.off("selection", onSelection);
		};
	}, [enabled, renderer, toast.show, clipboard]);

	return null;
}
