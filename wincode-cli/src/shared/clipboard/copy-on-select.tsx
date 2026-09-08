import type { Selection } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect } from "react";
import { useToast } from "../providers/toast/toast-provider";
import type { ToastOptions } from "../providers/toast/types";
import { writeClipboard } from "./clipboard";

type SelectionRenderer = ReturnType<typeof useRenderer>;

export async function handleSelection(
	selection: Pick<Selection, "getSelectedText">,
	renderer: Pick<SelectionRenderer, "clearSelection" | "copyToClipboardOSC52">,
	show: (options: ToastOptions) => void,
	write: typeof writeClipboard = writeClipboard
): Promise<void> {
	const text = selection.getSelectedText();
	if (!text) {
		return;
	}
	try {
		const copied = await write(renderer, text);
		show({
			message: copied ? "Copied to clipboard" : "Failed to copy selection.",
			variant: copied ? "success" : "error",
			...(copied ? { width: 30 } : {}),
		});
	} catch {
		show({ message: "Failed to copy selection.", variant: "error" });
	} finally {
		renderer.clearSelection();
	}
}

export function CopyOnSelect() {
	const renderer = useRenderer();
	const toast = useToast();

	useEffect(() => {
		const onSelection = (selection: Selection) => {
			void handleSelection(selection, renderer, toast.show);
		};
		renderer.on("selection", onSelection);
		return () => {
			renderer.off("selection", onSelection);
		};
	}, [renderer, toast.show]);

	return null;
}
