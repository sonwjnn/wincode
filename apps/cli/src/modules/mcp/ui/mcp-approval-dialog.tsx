import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { McpApprovalController } from "../context/approval-controller";
import type { McpApprovalRequest } from "../registry";

const MAX_INPUT_CHARS = 2048;
export const MAX_DESCRIPTION_CHARS = 2048;
const FORMATTED_INPUT_OVERFLOW = "…";

/**
 * Formats the tool-call input for display, bounded so a hostile or enormous
 * tool schema cannot flood the dialog. Never renders config, credentials,
 * headers, or URLs — only the tool-call arguments the model produced.
 */
export function formatApprovalInput(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input, null, 2);
	} catch {
		text = String(input);
	}
	if (text.length <= MAX_INPUT_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_INPUT_CHARS)}${FORMATTED_INPUT_OVERFLOW}`;
}

/**
 * Formats the tool description for display, bounded so a hostile or enormous
 * tool schema cannot flood the dialog.
 */
export function formatApprovalDescription(description: string): string {
	if (description.length <= MAX_DESCRIPTION_CHARS) {
		return description;
	}
	return `${description.slice(0, MAX_DESCRIPTION_CHARS)}${FORMATTED_INPUT_OVERFLOW}`;
}

type McpApprovalDialogContentProps = {
	controller: McpApprovalController;
	onClose: () => void;
	request: McpApprovalRequest;
};

export function McpApprovalDialogContent({
	controller,
	onClose,
	request,
}: McpApprovalDialogContentProps) {
	const [selectedAction, setSelectedAction] = useState<0 | 1>(0);
	const selectedActionRef = useRef<0 | 1>(0);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();

	// Closing the dialog (escape, backdrop, or action) unmounts this content and
	// settles any still-pending approval request with `false`.
	useEffect(() => () => controller.cancel(), [controller]);

	// OpenTUI keyboard callbacks are imperative and several keys can land before
	// React commits the next render. Mirror the selection into a ref and toggle
	// it synchronously so enter always resolves against the latest selection.
	useEffect(() => {
		selectedActionRef.current = selectedAction;
	}, [selectedAction]);

	const toggleSelectedAction = () => {
		const next: 0 | 1 = selectedActionRef.current === 0 ? 1 : 0;
		selectedActionRef.current = next;
		setSelectedAction(next);
	};

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (
			key.name === "down" ||
			key.name === "left" ||
			key.name === "right" ||
			key.name === "tab" ||
			key.name === "up"
		) {
			key.preventDefault();
			toggleSelectedAction();
			return;
		}
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			if (selectedActionRef.current === 0) {
				controller.allow();
			} else {
				controller.deny();
			}
			onClose();
		}
	});

	return (
		<box flexDirection="column" gap={1}>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				server
			</text>
			<text fg={colors.text}>{request.serverName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				tool
			</text>
			<text fg={colors.text}>{request.originalToolName}</text>
			{request.description.length > 0 && (
				<>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						description
					</text>
					<text fg={colors.text}>
						{formatApprovalDescription(request.description)}
					</text>
				</>
			)}
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				input
			</text>
			<box flexGrow={1} overflow="hidden">
				<text fg={colors.text} wrapMode="word">
					{formatApprovalInput(request.input)}
				</text>
			</box>
			<box flexDirection="row" gap={3} height={1} marginTop={1}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
				<text
					attributes={selectedAction === 0 ? TextAttributes.BOLD : undefined}
					fg={selectedAction === 0 ? colors.primary : colors.text}
					onMouseDown={() => {
						controller.allow();
						onClose();
					}}
				>
					{selectedAction === 0 ? "> Allow once" : "Allow once"}
				</text>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
				<text
					attributes={selectedAction === 1 ? TextAttributes.BOLD : undefined}
					fg={selectedAction === 1 ? colors.error : colors.text}
					onMouseDown={() => {
						controller.deny();
						onClose();
					}}
				>
					{selectedAction === 1 ? "> Deny" : "Deny"}
				</text>
			</box>
		</box>
	);
}

type McpApprovalDialogProps = {
	controller: McpApprovalController;
	request: McpApprovalRequest;
};

export function McpApprovalDialog({
	controller,
	request,
}: McpApprovalDialogProps) {
	const { close } = useDialog();
	useDialogEscape();
	return (
		<McpApprovalDialogContent
			controller={controller}
			onClose={close}
			request={request}
		/>
	);
}
