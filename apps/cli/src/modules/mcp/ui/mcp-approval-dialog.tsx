import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
	formatApprovalDescription,
	formatApprovalIdentity,
	formatApprovalInput,
} from "@/shared/providers/approval/format";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { McpApprovalController } from "../context/approval-controller";
import type { McpApprovalRequest } from "../registry";

export {
	formatApprovalDescription,
	MAX_DESCRIPTION_CHARS,
} from "@/shared/providers/approval/format";

// MCP tool approvals keep the simple allow-once / deny surface until the MCP
// migration ticket moves them onto the generic Permission service (temporary
// grants, auto approval, and rejection feedback). Reusing only the shared
// bounded formatters keeps that migration a drop-in replacement.
type IdentityRow = { label: string; value: string };

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

	const identity: IdentityRow[] = [
		{ label: "server", value: request.serverName },
		{ label: "tool", value: request.originalToolName },
	];

	useEffect(() => () => controller.cancel(), [controller]);

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
			{identity.map((row) => (
				<Fragment key={row.label}>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						{row.label}
					</text>
					<text fg={colors.text}>{formatApprovalIdentity(row.value)}</text>
				</Fragment>
			))}
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
