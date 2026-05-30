import { TextAttributes } from "@opentui/core";
import { getCodingMode } from "@wincode/ai";
import { usePromptConfig } from "../providers/prompt-config";
import { useTheme } from "../providers/theme";

export function StatusBar() {
	const { mode } = usePromptConfig();
	const { colors } = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={mode === "plan" ? colors.planMode : colors.primary}>
				{getCodingMode(mode).displayName}
			</text>
			<text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
				∙
			</text>
			<text>model</text>
		</box>
	);
}
