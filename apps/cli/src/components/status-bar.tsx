import { TextAttributes } from "@opentui/core";
import { findSupportedChatModel, getCodingMode } from "@wincode/ai";
import { usePromptConfig } from "../providers/prompt-config";
import { useTheme } from "../providers/theme";

export function StatusBar() {
	const { mode, model } = usePromptConfig();
	const { colors } = useTheme();
	const chatModel = findSupportedChatModel(model);
	return (
		<box flexDirection="row" gap={1}>
			<text fg={colors.mode[mode]}>{getCodingMode(mode).displayName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
				∙
			</text>
			<text>{chatModel?.displayName ?? model}</text>
		</box>
	);
}
