import { InputDialog } from "@wincode/tui";
import { useCallback, useEffect, useRef } from "react";
import {
	useDialog,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { DialogInset } from "@/shared/ui/dialog-inset";

type PluginTextInputDialogProps = Readonly<{
	onResolve: (value: string | undefined) => void;
	prompt: string;
}>;

export const PluginTextInputDialog = ({
	onResolve,
	prompt,
}: PluginTextInputDialogProps) => {
	const settledRef = useRef(false);
	const { close } = useDialog();
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

	return (
		<DialogInset>
			<InputDialog
				active={isTopLayer(layerId)}
				onCancel={() => finish(undefined)}
				onSubmit={(value) => {
					const trimmed = value.trim();
					if (trimmed.length > 0) {
						finish(trimmed);
					}
				}}
				prompt={prompt}
			/>
		</DialogInset>
	);
};
