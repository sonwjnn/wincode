import { TextAttributes } from "@opentui/core";
import type { ThinkingSelection } from "@wincode/ai";
import { resolveEffectiveAgentSelection } from "@/modules/agents/agent-call";
import { useAgentRegistry } from "@/modules/agents/agent-registry-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar({
	thinkingSelection,
}: {
	thinkingSelection?: ThinkingSelection;
}) {
	const {
		agent,
		model,
		thinkingLevel: promptThinkingLevel,
		submissionSelectionOverride,
	} = usePromptConfig();
	const registry = useAgentRegistry();
	const effective = resolveEffectiveAgentSelection(
		registry,
		agent,
		model,
		promptThinkingLevel === undefined
			? {}
			: { thinkingLevel: promptThinkingLevel },
		false,
		submissionSelectionOverride
	);
	const thinkingLevel =
		thinkingSelection === undefined
			? effective.thinkingLevel
			: thinkingSelection.thinkingLevel;
	const { colors } = useTheme();
	const modelName = `${effective.model.providerId}/${effective.model.modelId}`;
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
