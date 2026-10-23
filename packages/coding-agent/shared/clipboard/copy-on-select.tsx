import type { KeyEvent, Selection } from "@opentui/core";
import { useAppContext, useRenderer } from "@opentui/react";
import { useEffect } from "react";
import { useOptionalKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useToast } from "../providers/toast/toast-provider";
import type { CopyBehavior } from "./copy-behavior";
import { useClipboard } from "./provider";
import {
	copySelection,
	handleSelection,
	handleSelectionKey,
} from "./selection";
import { subscribeSelectionCopyRequest } from "./selection-copy-requests";

export type CopyOnSelectProps = {
	behavior: CopyBehavior;
};

export function CopyOnSelect({ behavior }: CopyOnSelectProps) {
	const renderer = useRenderer();
	const clipboard = useClipboard();
	const toast = useToast();
	const { keyHandler } = useAppContext();
	const keyboardLayer = useOptionalKeyboardLayer();
	const enabled = behavior === "select";

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

	useEffect(
		() =>
			subscribeSelectionCopyRequest(() => {
				if (enabled) {
					return false;
				}
				if (keyboardLayer && !keyboardLayer.isTopLayer("base")) {
					return false;
				}
				const selection = renderer.getSelection();
				if (!selection) {
					return false;
				}
				return copySelection(selection, {
					clipboard,
					focusedRenderable: renderer.currentFocusedRenderable ?? undefined,
					show: toast.show,
				});
			}),
		[enabled, keyboardLayer, renderer, toast.show, clipboard]
	);

	useEffect(() => {
		if (!keyHandler) {
			return;
		}
		const onKey = (key: KeyEvent) => {
			if (keyboardLayer && !keyboardLayer.isTopLayer("base")) {
				return;
			}
			handleSelectionKey(
				key,
				{
					clearSelection: () => renderer.clearSelection(),
					currentFocusedEditor: renderer.currentFocusedEditor,
					currentFocusedRenderable: renderer.currentFocusedRenderable,
					getSelection: () => renderer.getSelection(),
				},
				{ clipboard, show: toast.show }
			);
		};
		// Run before dialog/session key handlers, just as OpenCode intercepts
		// selection keys ahead of its app bindings.
		keyHandler.prependListener("keypress", onKey);
		return () => {
			keyHandler.off("keypress", onKey);
		};
	}, [keyHandler, keyboardLayer, renderer, toast.show, clipboard]);

	return null;
}
