import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { ApprovalControllerActions } from "../approval-controller";
import {
	formatApprovalDescription,
	formatApprovalIdentity,
	formatApprovalInput,
} from "../format";

export type ApprovalIdentityRow = {
	label: string;
	value: string;
};

/**
 * One generic bounded tool-approval request. `identity` carries the tool
 * identity and canonical resource rows (for example `tool`/`resource`), while
 * `description` and `input` are the bounded tool description and call input.
 * `safety` marks an approval raised by the manual-only safety ceiling, so the
 * dialog can warn that the governing config is untrusted.
 */
export type ToolApprovalRequest = {
	description: string;
	identity: readonly ApprovalIdentityRow[];
	input: unknown;
	safety?: boolean;
};

type ToolApprovalDialogContentProps = {
	controller: ApprovalControllerActions;
	onClose: () => void;
	request: ToolApprovalRequest;
};

export function ToolApprovalDialogContent({
	controller,
	onClose,
	request,
}: ToolApprovalDialogContentProps) {
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
			{request.safety === true && (
				<text attributes={TextAttributes.BOLD} fg={colors.error}>
					Safety ceiling: the governing Tool Permission config is malformed, so
					every action must be approved manually.
				</text>
			)}
			{request.identity.map((row) => (
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

type ToolApprovalDialogProps = {
	controller: ApprovalControllerActions;
	request: ToolApprovalRequest;
};

export function ToolApprovalDialog({
	controller,
	request,
}: ToolApprovalDialogProps) {
	const { close } = useDialog();
	useDialogEscape();
	return (
		<ToolApprovalDialogContent
			controller={controller}
			onClose={close}
			request={request}
		/>
	);
}
