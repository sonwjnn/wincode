import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getErrorMessage, sanitizeText } from "@wincode/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionId } from "@/shared/identifiers";
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
import { getInteractiveSessionHostManager } from "../../host/session-host-manager";
import type { SessionBundleExportScope } from "../../session-bundle-contract";
import {
	createSessionBundleExportOperation,
	SessionBundleExportError,
} from "../../session-bundle-export";
import { getSessionStore } from "../../storage/get-session-store";

export const formatSessionBundleExportFailure = (error: unknown): string => {
	const message = getErrorMessage(error, "Failed to export Session bundle");
	if (
		error instanceof SessionBundleExportError &&
		(error.code === "session_log_corrupt" ||
			error.code === "session_log_version_unsupported")
	) {
		return sanitizeText(
			`${message} (Session ${error.sessionId}; sequence ${error.sequence ?? "unknown"}; byte offset ${error.offset ?? "unknown"})`
		);
	}
	return sanitizeText(message);
};

export type ExportSessionDialogProps = Readonly<{
	session: Readonly<{ id: SessionId; title: string }>;
}>;

export function ExportSessionDialog({ session }: ExportSessionDialogProps) {
	const inputRef = useRef<InputRenderable>(null);
	const abortControllerRef = useRef<AbortController | null>(null);
	const [exporting, setExporting] = useState(false);
	const [focusedField, setFocusedField] = useState<"destination" | "scope">(
		"destination"
	);
	const [scopeIndex, setScopeIndex] = useState(0);
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
		const destination = inputRef.current?.value.trim() ?? "";
		if (destination.length === 0 || exporting) {
			return;
		}
		const controller = new AbortController();
		abortControllerRef.current = controller;
		setExporting(true);
		try {
			const exportSessionBundle = createSessionBundleExportOperation(
				getInteractiveSessionHostManager(),
				getSessionStore()
			);
			const scope: SessionBundleExportScope =
				scopeIndex === 0 ? "tree" : "branch";
			const result = await exportSessionBundle({
				destination,
				scope,
				sessionId: session.id,
				signal: controller.signal,
				sourceWorkspacePath: process.cwd(),
			});
			show({
				message: sanitizeText(
					`Exported ${result.manifest.scope} Session bundle ${result.sessionId} to ${result.destination}`
				),
				variant: "success",
			});
			close();
		} catch (error) {
			if (!controller.signal.aborted) {
				show({
					message: formatSessionBundleExportFailure(error),
					variant: "error",
				});
			}
		} finally {
			abortControllerRef.current = null;
			setExporting(false);
		}
	}, [close, exporting, scopeIndex, session.id, show]);

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "tab") {
			key.preventDefault();
			setFocusedField((current) =>
				current === "destination" ? "scope" : "destination"
			);
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
					Export {session.title} locally. Whole tree keeps the Session identity;
					Selected Path creates a standalone Session with a new identity.
					Nothing is uploaded.
				</text>
				<input
					focused={focusedField === "destination"}
					focusedTextColor={colors.text}
					onContentChange={() => undefined}
					placeholder="./session-bundle"
					ref={inputRef}
					textColor={colors.text}
				/>
				<text selectable={false}>Export scope (default: Whole tree)</text>
				<select
					focused={focusedField === "scope"}
					height={4}
					onChange={(index) => setScopeIndex(index)}
					options={[
						{
							name: "Whole tree",
							description: "All history branches and the Active Leaf",
						},
						{
							name: "Selected Path",
							description:
								"Only the current path; creates a new Session identity",
						},
					]}
					selectedIndex={scopeIndex}
				/>
				<box flexDirection="row" gap={2} height={1} marginTop={2}>
					<DialogFooterHint
						label={exporting ? "exporting" : "export"}
						shortcut="enter"
					/>
					<DialogFooterHint label="switch field" shortcut="tab" />
					<DialogFooterHint label="cancel" shortcut="esc" />
				</box>
			</box>
		</DialogInset>
	);
}
