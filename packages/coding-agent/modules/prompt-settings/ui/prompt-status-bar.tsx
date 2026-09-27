import { TextAttributes } from "@opentui/core";
import {
	findSupportedChatModelSelection,
	formatModelLabel,
} from "@wincode/ai/models";
import { agentLabelFromId, useAgentRegistry } from "@/modules/agents";
import { AutoApprovalIndicator } from "@/modules/permissions";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { agent, effort, model, reasoningMode } = usePromptConfig();
	const { colors } = useTheme();
	const agentColor = getAgentColor(colors, agent);
	const registry = useAgentRegistry();
	const agentLabel =
		registry?.agents.find(({ id }) => id === agent)?.displayName ??
		agentLabelFromId(agent);
	const chatModel = findSupportedChatModelSelection(model);
	const modelName = chatModel
		? formatModelLabel(chatModel.displayName)
		: model.modelId;
	let reasoningLabel = "default";
	if (reasoningMode !== undefined) {
		reasoningLabel = `Reasoning Mode: ${reasoningMode}`;
	}
	if (effort !== undefined) {
		reasoningLabel = `Effort: ${effort}`;
	}
	return (
		<box flexDirection="row" gap={1}>
			<text fg={agentColor}>{agentLabel}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				∙
			</text>
			<text fg={colors.text}>{modelName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				∙
			</text>
			<text attributes={TextAttributes.BOLD} fg={colors.secondary}>
				{reasoningLabel}
			</text>
			<AutoApprovalIndicator />
		</box>
	);
}
