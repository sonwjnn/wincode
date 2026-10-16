import { connectionProviderDisplayNames } from "@wincode/ai/connections";
import {
	findSupportedChatModelSelection,
	formatModelLabel,
} from "@wincode/ai/models";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { model, thinkingLevel } = usePromptConfig();
	const { colors } = useTheme();
	const supportedModel = findSupportedChatModelSelection(model);
	const modelName = supportedModel
		? formatModelLabel(supportedModel.displayName)
		: model.modelId;
	const thinkingValue = thinkingLevel ?? "default";
	return (
		<box
			backgroundColor={colors.background}
			bottom={0}
			paddingX={1}
			position="absolute"
			right={2}
			zIndex={1}
		>
			<text fg={colors.textMuted}>
				{connectionProviderDisplayNames[model.providerId]} · {modelName} (
				{thinkingValue})
			</text>
		</box>
	);
}
