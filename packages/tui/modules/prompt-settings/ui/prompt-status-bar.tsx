import { TextAttributes } from "@opentui/core";
import {
	findSupportedChatModelSelection,
	formatModelLabel,
	normalizeModelVariant,
} from "@wincode/ai/models";
import { agentLabelFromId, useAgentRegistry } from "@/modules/agents";
import { AutoApprovalIndicator } from "@/modules/permissions";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { agent, model, variant } = usePromptConfig();
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
	const variantName = normalizeModelVariant(model, variant) ?? "default";
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
				{variantName}
			</text>
			<AutoApprovalIndicator />
		</box>
	);
}
