import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";
import {
	useDialog,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { DialogInset } from "@/shared/ui/dialog-inset";

type PluginTextInputDialogProps = Readonly<{
	onResolve: (value: string | undefined) => void;
	prompt: string;
}>;

export const PluginTextInputDialog = ({
	onResolve,
	prompt,
}: PluginTextInputDialogProps) => {
	const inputRef = useRef<InputRenderable>(null);
	const settledRef = useRef(false);
	const { close } = useDialog();
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();

	const finish = useCallback(
		(value: string | undefined) => {
			if (settledRef.current) {
				return;
			}
			settledRef.current = true;
			onResolve(value);
			close();
		},
		[close, onResolve]
	);

	useEffect(
		() => () => {
			if (!settledRef.current) {
				settledRef.current = true;
				onResolve(undefined);
			}
		},
		[onResolve]
	);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "escape") {
			key.preventDefault();
			finish(undefined);
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			const value = (inputRef.current?.value ?? "").trim();
			if (value.length > 0) {
				key.preventDefault();
				finish(value);
			}
		}
	});

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				<text fg={colors.text} selectable={false} wrapMode="word">
					{prompt}
				</text>
				<input
					focused
					focusedTextColor={colors.text}
					onContentChange={() => undefined}
					ref={inputRef}
					textColor={colors.text}
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={2}>
					<DialogFooterHint label="submit" shortcut="enter" />
					<DialogFooterHint label="cancel" shortcut="escape" />
				</box>
			</box>
		</DialogInset>
	);
};
