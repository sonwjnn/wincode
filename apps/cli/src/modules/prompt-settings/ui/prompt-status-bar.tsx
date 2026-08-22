import { TextAttributes } from "@opentui/core";
import {
	findSupportedChatModelSelection,
	formatModelLabel,
	normalizeModelVariant,
} from "@wincode/ai";
import { agentLabelFromId, useAgentRegistry } from "@/modules/agents";
import { connectionProviderDisplayNames } from "@/modules/connections";
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
	const providerName = connectionProviderDisplayNames[model.providerId];
	const variantName = normalizeModelVariant(model, variant) ?? undefined;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={agentColor}>{agentLabel}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				∙
			</text>
			<text fg={colors.text}>{modelName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				{providerName}
			</text>
			{variantName ? (
				<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
					∙
				</text>
			) : null}
			{variantName ? (
				<text attributes={TextAttributes.BOLD} fg={colors.secondary}>
					{variantName}
				</text>
			) : null}
			<AutoApprovalIndicator />
		</box>
	);
}
