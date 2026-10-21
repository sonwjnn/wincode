import { TextAttributes } from "@opentui/core";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { model, thinkingLevel } = usePromptConfig();
	const { colors } = useTheme();
	const modelName = `${model.providerId}/${model.modelId}`;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={colors.text}>{modelName}</text>
			{thinkingLevel === undefined ? null : (
				<>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						∙
					</text>
					<text attributes={TextAttributes.BOLD} fg={colors.secondary}>
						{thinkingLevel}
					</text>
				</>
			)}
		</box>
	);
}
