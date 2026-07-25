import { TextAttributes } from "@opentui/core";
import {
	findSupportedChatModelSelection,
	getChatModelRoute,
	getCodingMode,
	normalizeModelVariant,
} from "@wincode/ai";
import { getBillingStatusLabel, useBilling } from "@/modules/billing";
import { connectionProviderDisplayNames } from "@/modules/connections";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { usePromptConfig } from "../context/prompt-config-provider";

export function StatusBar() {
	const { mode, model, variant } = usePromptConfig();
	const billing = useBilling();
	const { colors } = useTheme();
	const chatModel = findSupportedChatModelSelection(model);
	const modelName = chatModel?.displayName ?? model.modelId;
	const providerName = connectionProviderDisplayNames[model.providerId];
	const variantName = normalizeModelVariant(model, variant) ?? undefined;
	const isHosted = getChatModelRoute(model) === "hosted";
	const billingLabel = getBillingStatusLabel(isHosted, billing);
	return (
		<box flexDirection="row" gap={1}>
			<text fg={colors.mode[mode]}>{getCodingMode(mode).displayName}</text>
			<text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
				∙
			</text>
			<text>{modelName}</text>
			<text attributes={TextAttributes.DIM}>{providerName}</text>
			{variantName ? <text attributes={TextAttributes.DIM}>∙</text> : null}
			{variantName ? <text fg={colors.mode[mode]}>{variantName}</text> : null}
			<text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
				∙
			</text>
			<text attributes={TextAttributes.DIM}>{billingLabel}</text>
		</box>
	);
}
