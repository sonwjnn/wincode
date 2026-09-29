import { TextAttributes } from "@opentui/core";
import type { SessionWriterLockOwner } from "@/modules/sessions/storage/session-writer-lock";
import { useTheme } from "@/shared/providers/theme/theme-provider";

const formatSessionWriterOwner = (owner?: SessionWriterLockOwner): string => {
	if (owner === undefined) {
		return "Lock owner details unavailable; all owner information is unverified.";
	}
	const mode =
		owner.executionMode === undefined ? "" : ` · mode ${owner.executionMode}`;
	return `Unverified lock owner: PID ${owner.pid}${mode} · opened ${owner.openedAt}`;
};

export function SessionWriterOwnerLabel({
	owner,
}: {
	owner?: SessionWriterLockOwner;
}) {
	const { colors } = useTheme();
	return <text fg={colors.textMuted}>{formatSessionWriterOwner(owner)}</text>;
}

export function SessionWriterAction({
	disabled,
	id,
	label,
	onActivate,
}: {
	disabled: boolean;
	id: string;
	label: string;
	onActivate: () => void;
}) {
	const { colors } = useTheme();
	const activate = () => {
		if (!disabled) {
			onActivate();
		}
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse and keyboard events.
		<box
			focusable
			id={id}
			onKeyDown={(key) => {
				if (
					key.name !== "enter" &&
					key.name !== "return" &&
					key.name !== "space"
				) {
					return;
				}
				key.preventDefault();
				activate();
			}}
			onMouseDown={activate}
		>
			<text
				attributes={TextAttributes.BOLD}
				fg={disabled ? colors.textMuted : colors.primary}
				selectable={false}
			>
				{label}
			</text>
		</box>
	);
}
