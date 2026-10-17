import type { ReactNode } from "react";
import { useTheme } from "@/shared/providers/theme/theme-provider";

export type InlineNoticeVariant = "warning" | "error" | "info" | "success";

export type InlineNoticeProps = Readonly<{
	children: ReactNode;
	variant?: InlineNoticeVariant;
}>;

/**
 * A block of notice text whose variant selects its theme color. Callers own
 * placement and padding; the notice only supplies width and wrapping.
 */
export function InlineNotice({
	children,
	variant = "info",
}: InlineNoticeProps) {
	const { colors } = useTheme();
	return (
		<box flexShrink={0} width="100%">
			<text fg={colors[variant]} wrapMode="word">
				{children}
			</text>
		</box>
	);
}
