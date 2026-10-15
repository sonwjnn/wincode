import { connectionProviderDisplayNames } from "@wincode/ai/connections";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { model } = usePromptConfig();
	const { colors } = useTheme();
	return (
		<box
			backgroundColor={colors.backgroundElement}
			bottom={0}
			paddingX={1}
			position="absolute"
			right={2}
			zIndex={1}
		>
			<text fg={colors.textMuted}>
				{connectionProviderDisplayNames[model.providerId]}
			</text>
		</box>
	);
}
