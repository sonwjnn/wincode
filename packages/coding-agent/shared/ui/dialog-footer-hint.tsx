import type { RGBA } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { useTheme } from "../providers/theme/theme-provider";

type DialogFooterHintProps = {
	readonly label: ReactNode;
	readonly shortcut: ReactNode;
	readonly shortcutColor?: string | RGBA;
};

export function DialogFooterHint({
	label,
	shortcut,
	shortcutColor,
}: DialogFooterHintProps) {
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={shortcutColor ?? colors.text}>{shortcut}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				{label}
			</text>
		</box>
	);
}
