import { type InputRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
	useDialog,
	useDialogEscape,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
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
 * dialog can warn that the governing config is untrusted and suppress the
 * "always" grant that a safety ask must never create.
 */
export type ToolApprovalRequest = {
	description: string;
	identity: readonly ApprovalIdentityRow[];
	input: unknown;
	safety?: boolean;
};

/**
 * The imperative surface the dialog drives. `allow` runs the tool once, and
 * `remember` records a temporary grant for the exact action/resource. `reject`
 * blocks the tool and returns the optional typed correction to the Agent, and —
 * because the queue behind it is conversation-scoped — settles every other
 * pending approval in the same conversation. `cancel` rejects without feedback
 * when the dialog unmounts.
 */
export type ToolApprovalActions = {
	allow(remember: boolean): void;
	reject(feedback?: string): void;
	cancel(): void;
};

type ApprovalOption =
	| { kind: "allow-once"; label: string }
	| { kind: "always"; label: string }
	| { kind: "reject"; label: string };

const buildOptions = (safety: boolean): ApprovalOption[] => {
	const allowOnce: ApprovalOption = {
		kind: "allow-once",
		label: "Allow once",
	};
	const reject: ApprovalOption = { kind: "reject", label: "Reject" };
	// A safety ask must never mint a grant, so "always" is omitted under the
	// manual-only ceiling; only allow-once and reject remain.
	return safety
		? [allowOnce, reject]
		: [allowOnce, { kind: "always", label: "Always allow" }, reject];
};

type ToolApprovalDialogContentProps = {
	actions: ToolApprovalActions;
	onClose: () => void;
	request: ToolApprovalRequest;
};

export function ToolApprovalDialogContent({
	actions,
	onClose,
	request,
}: ToolApprovalDialogContentProps) {
	const options = buildOptions(request.safety === true);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selectedIndexRef = useRef(0);
	const feedbackRef = useRef<InputRenderable>(null);
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const { colors } = useTheme();

	// Closing the dialog (escape, backdrop, or action) unmounts this content and
	// rejects any still-pending approval requests in the conversation.
	useEffect(() => () => actions.cancel(), [actions]);

	// OpenTUI keyboard callbacks are imperative and several keys can land before
	// React commits the next render. Mirror the selection into a ref and advance
	// it synchronously so enter always resolves against the latest selection even
	// under rapid input.
	useEffect(() => {
		selectedIndexRef.current = selectedIndex;
	}, [selectedIndex]);

	const moveSelection = (delta: number) => {
		const count = options.length;
		const next = (selectedIndexRef.current + delta + count) % count;
		selectedIndexRef.current = next;
		setSelectedIndex(next);
	};

	const confirm = (index: number) => {
		const option = options[index];
		if (option === undefined) {
			return;
		}
		if (option.kind === "reject") {
			actions.reject(feedbackRef.current?.value ?? undefined);
		} else {
			actions.allow(option.kind === "always");
		}
		onClose();
	};

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}
		if (key.name === "up") {
			key.preventDefault();
			moveSelection(-1);
			return;
		}
		if (key.name === "down" || key.name === "tab") {
			key.preventDefault();
			moveSelection(1);
			return;
		}
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			confirm(selectedIndexRef.current);
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
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				rejection feedback (optional)
			</text>
			<input
				focused
				focusedTextColor={colors.text}
				onContentChange={() => undefined}
				ref={feedbackRef}
				textColor={colors.text}
			/>
			<box flexDirection="row" gap={3} height={1} marginTop={1}>
				{options.map((option, index) => {
					const isSelected = index === selectedIndex;
					const color =
						option.kind === "reject" ? colors.error : colors.primary;
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events.
						<text
							attributes={isSelected ? TextAttributes.BOLD : undefined}
							fg={isSelected ? color : colors.text}
							key={option.kind}
							onMouseDown={() => confirm(index)}
						>
							{isSelected ? `> ${option.label}` : option.label}
						</text>
					);
				})}
			</box>
		</box>
	);
}

type ToolApprovalDialogProps = {
	actions: ToolApprovalActions;
	request: ToolApprovalRequest;
};

export function ToolApprovalDialog({
	actions,
	request,
}: ToolApprovalDialogProps) {
	const { close } = useDialog();
	useDialogEscape();
	return (
		<ToolApprovalDialogContent
			actions={actions}
			onClose={close}
			request={request}
		/>
	);
}
