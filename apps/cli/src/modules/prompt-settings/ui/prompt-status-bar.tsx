import { TextAttributes } from "@opentui/core";
import {
	findSupportedChatModelSelection,
	formatModelLabel,
	getCodingMode,
	normalizeModelVariant,
} from "@wincode/ai";
import { connectionProviderDisplayNames } from "@/modules/connections";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { mode, model, variant } = usePromptConfig();
	const { colors } = useTheme();
	const chatModel = findSupportedChatModelSelection(model);
	const modelName = chatModel
		? formatModelLabel(chatModel.displayName)
		: model.modelId;
	const providerName = connectionProviderDisplayNames[model.providerId];
	const variantName = normalizeModelVariant(model, variant) ?? undefined;
	return (
		<box flexDirection="row" gap={1}>
			<text fg={colors.mode[mode]}>{getCodingMode(mode).displayName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
				∙
			</text>
			<text>{modelName}</text>
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
