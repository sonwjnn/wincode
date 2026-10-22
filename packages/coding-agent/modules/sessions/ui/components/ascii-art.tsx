import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/shared/providers/theme/theme-provider";

type AsciiArtFont = "tiny" | "slick" | "block";

const getAsciiArtFont = (
	width: number,
	height: number
): AsciiArtFont | undefined => {
	if (width < 30 || height < 12) {
		return;
	}
	if (height < 16 || width < 44) {
		return "tiny";
	}
	if (width < 64) {
		return "slick";
	}
	return "block";
};

export function AsciiArt() {
	const { height, width } = useTerminalDimensions();
	const { colors } = useTheme();
	const font = getAsciiArtFont(width, height);

	if (font === undefined) {
		return null;
	}

	return (
		<box alignItems="center" justifyContent="center">
			<box
				alignItems="center"
				flexDirection="row"
				gap={0.5}
				justifyContent="center"
			>
				<ascii-font color={colors.textMuted} font={font} text="Win" />
				<ascii-font color={colors.text} font={font} text="Code" />
			</box>
		</box>
	);
}
