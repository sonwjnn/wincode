import { TextAttributes } from "@opentui/core";
import { getCodingMode } from "@wincode/ai";
import { usePromptConfig } from "../providers/prompt-config";
import { useTheme } from "../providers/theme";

export function StatusBar() {
	const { modeName } = usePromptConfig();
	const { colors } = useTheme();

	const isPlanMode = modeName === "plan";
	const modeColor = isPlanMode ? colors.planMode : colors.primary;

	return (
		<box flexDirection="row" gap={1}>
			<text fg={modeColor}>{getCodingMode(modeName).displayName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
				›
			</text>
		</box>
	);
}
