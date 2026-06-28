import type { ReactNode } from "react";
import { useTheme } from "@/shared/terminal/theme/theme-provider";

type Props = {
	children: ReactNode;
};

export function ThemedRoot({ children }: Props) {
	const { colors } = useTheme();

	return (
		<box
			backgroundColor={colors.background}
			flexGrow={1}
			height="100%"
			width="100%"
		>
			{children}
		</box>
	);
}
