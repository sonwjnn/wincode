import { TextAttributes } from "@opentui/core";
import type { ThinkingSelection } from "@wincode/ai";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar({
	thinkingSelection,
}: {
	thinkingSelection?: ThinkingSelection;
}) {
	const { model, thinkingLevel: promptThinkingLevel } = usePromptConfig();
	const thinkingLevel =
		thinkingSelection === undefined
			? promptThinkingLevel
			: thinkingSelection.thinkingLevel;
	const { colors } = useTheme();
	const modelName = `${model.providerId}/${model.modelId}`;
	return (
		<box flexDirection="row">
			<text fg={colors.text}>{modelName}</text>
			{thinkingLevel === undefined ? null : (
				<text attributes={TextAttributes.BOLD} fg={colors.secondary}>
					:{thinkingLevel}
				</text>
			)}
		</box>
	);
}
