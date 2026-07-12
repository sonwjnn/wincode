import { TextAttributes } from "@opentui/core";
import { findSupportedChatModelSelection, getCodingMode } from "@wincode/ai";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { mode, model } = usePromptConfig();
	const { colors } = useTheme();
	const chatModel = findSupportedChatModelSelection(model);
	const modelName = chatModel?.displayName ?? model.modelId;
	const providerName = chatModel?.connectionProviderId ?? model.providerId;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={colors.mode[mode]}>{getCodingMode(mode).displayName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
				∙
			</text>
			<text>{modelName}</text>
			<text attributes={TextAttributes.DIM}>{providerName}</text>
		</box>
	);
}
