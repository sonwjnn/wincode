import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef } from "react";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { getConversationStore } from "../../storage/get-conversation-store";

type RenameSessionDialogProps = {
	session: { id: string; title: string };
	onSuccess: (newTitle: string) => void;
};

export function RenameSessionDialog({
	session,
	onSuccess,
}: RenameSessionDialogProps) {
	const inputRef = useRef<InputRenderable>(null);
	const { close } = useDialog();
	const { colors } = useTheme();

	// biome-ignore lint/correctness/useExhaustiveDependencies: Only prefill once on mount.
	useEffect(() => {
		if (inputRef.current) {
			inputRef.current.value = session.title;
		}
	}, []);
	const { show } = useToast();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();

	const handleSubmit = useCallback(async () => {
		const trimmed = (inputRef.current?.value ?? "").trim();
		if (!trimmed || trimmed === session.title) {
			close();
			return;
		}

		try {
			await getConversationStore().updateSession(session.id, {
				title: trimmed,
			});
			onSuccess(trimmed);
			close();
		} catch (error) {
			show({
				variant: "error",
				message:
					error instanceof Error ? error.message : "Failed to rename session",
			});
		}
	}, [session.id, session.title, close, onSuccess, show]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			handleSubmit();
		}
	});

	useDialogEscape();

	return (
		<box flexDirection="column" gap={1}>
			<input
				focused
				focusedTextColor={colors.text}
				onContentChange={() => undefined}
				ref={inputRef}
				textColor={colors.text}
			/>
			<box flexDirection="row" gap={2} height={1} marginTop={2}>
				<DialogFooterHint label="submit" shortcut="enter" />
			</box>
		</box>
	);
}
