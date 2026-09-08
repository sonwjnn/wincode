import { useTheme } from "@/shared/providers/theme/theme-provider";

export function AsciiArt() {
	const { colors } = useTheme();
	return (
		<box alignItems="center" justifyContent="center">
			<box
				alignItems="center"
				flexDirection="row"
				gap={0.5}
				justifyContent="center"
			>
				<ascii-font color={colors.textMuted} font="block" text="Win" />
				<ascii-font color={colors.text} font="block" text="Code" />
			</box>
		</box>
	);
}
