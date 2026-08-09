import { TextAttributes } from "@opentui/core";
import {
	findSupportedChatModelSelection,
	formatModelLabel,
	normalizeModelVariant,
} from "@wincode/ai";
import { agentLabelFromId, useAgentRegistry } from "@/modules/agents";
import { connectionProviderDisplayNames } from "@/modules/connections";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { agent, mode, model, variant } = usePromptConfig();
	const { colors } = useTheme();
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
			<text fg={colors.mode[mode]}>{agentLabel}</text>
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
			{variantName ? <text fg={colors.mode[mode]}>{variantName}</text> : null}
		</box>
	);
}
