import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getErrorMessage, sanitizeText } from "@wincode/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { DialogInset } from "@/shared/ui/dialog-inset";
import type { SessionBundleImportResult } from "../../session-bundle-contract";
import { createSessionBundleImportOperation } from "../../session-bundle-import";
import { getSessionStore } from "../../storage/get-session-store";

export const formatSessionBundleImportFailure = (error: unknown): string => {
	if (
		error instanceof Error &&
		typeof Reflect.get(error, "code") === "string"
	) {
		return sanitizeText(
			`Session bundle import failed (${Reflect.get(error, "code")}): ${getErrorMessage(error, "Import failed")}`
		);
	}
	return sanitizeText(getErrorMessage(error, "Session bundle import failed"));
};

export type ImportSessionDialogProps = Readonly<{
	onImported?: (result: SessionBundleImportResult) => void | Promise<void>;
}>;

export function ImportSessionDialog({ onImported }: ImportSessionDialogProps) {
	const inputRef = useRef<InputRenderable>(null);
	const abortControllerRef = useRef<AbortController | null>(null);
	const [importing, setImporting] = useState(false);
	const { close } = useDialog();
	const { colors } = useTheme();
	const { show } = useToast();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();

	useEffect(
		() => () => {
			abortControllerRef.current?.abort();
		},
		[]
	);

	const handleSubmit = useCallback(async () => {
		const bundlePath = inputRef.current?.value.trim() ?? "";
		if (bundlePath.length === 0 || importing) {
			return;
		}
		const controller = new AbortController();
		abortControllerRef.current = controller;
		setImporting(true);
		try {
			const result = await createSessionBundleImportOperation(
				getSessionStore()
			)({
				bundlePath,
				signal: controller.signal,
			});
			const disposition =
				result.status === "unchanged" ? "already present" : "imported";
			const activation = result.activationPending
				? " It remains idle until you explicitly continue or send input."
				: "";
			show({
				message: sanitizeText(
					`Session ${result.sessionId} ${disposition}.${activation}`
				),
				variant: "success",
			});
			await onImported?.(result);
			close();
		} catch (error) {
			if (!controller.signal.aborted) {
				show({
					message: formatSessionBundleImportFailure(error),
					variant: "error",
				});
			}
		} finally {
			abortControllerRef.current = null;
			setImporting(false);
		}
	}, [close, importing, onImported, show]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			void handleSubmit();
		}
	});

	useDialogEscape();

	return (
		<DialogInset>
			<box flexDirection="column" gap={1}>
				<text selectable={false}>
					Import a validated local Session bundle into this workspace. Imported
					Sessions open idle and never replay old work automatically.
				</text>
				<input
					focused
					focusedTextColor={colors.text}
					onContentChange={() => undefined}
					placeholder="./session-bundle"
					ref={inputRef}
					textColor={colors.text}
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={2}>
					<DialogFooterHint
						label={importing ? "importing" : "import"}
						shortcut="enter"
					/>
					<DialogFooterHint label="cancel" shortcut="esc" />
				</box>
			</box>
		</DialogInset>
	);
}
