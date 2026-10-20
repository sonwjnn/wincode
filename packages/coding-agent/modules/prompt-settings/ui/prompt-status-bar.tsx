import { TextAttributes } from "@opentui/core";
import { agentLabelFromId } from "@wincode/agent-core";
import { useAgentRegistry } from "@/modules/agents";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { agent, model, thinkingLevel } = usePromptConfig();
	const { colors } = useTheme();
	const agentColor = getAgentColor(colors, agent);
	const registry = useAgentRegistry();
	const agentLabel =
		registry?.agents.find(({ id }) => id === agent)?.displayName ??
		agentLabelFromId(agent);
	const modelName = `${model.providerId}/${model.modelId}`;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={agentColor}>{agentLabel}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				∙
			</text>
			<text fg={colors.text}>{modelName}</text>
			{thinkingLevel === undefined ? null : (
				<>
					<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
						∙
					</text>
					<text attributes={TextAttributes.BOLD} fg={colors.secondary}>
						{thinkingLevel === "off" ? "thinking off" : thinkingLevel}
					</text>
				</>
			)}
		</box>
	);
}
