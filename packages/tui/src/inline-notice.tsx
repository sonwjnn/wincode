import type { ReactNode } from "react";
import { useTheme } from "./theme";

export type InlineNoticeVariant = "warning" | "error" | "info" | "success";

export type InlineNoticeProps = Readonly<{
	children: ReactNode;
	variant?: InlineNoticeVariant;
}>;

/** A wrapped notice line colored by the active theme. */
export function InlineNotice({
	children,
	variant = "info",
}: InlineNoticeProps) {
	const { colors } = useTheme();
	const color = colors[variant];
	return (
		<box flexShrink={0} width="100%">
			<text fg={color} wrapMode="word">
				{children}
			</text>
		</box>
	);
}
