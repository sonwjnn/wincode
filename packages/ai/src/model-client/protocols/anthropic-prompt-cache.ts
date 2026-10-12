import type {
	ModelMetadataEntry,
	SupportedPromptCacheRetentionTier,
} from "../../model-metadata";
import type { SupportedChatModel } from "../../models";
import type { ModelProtocolPromptCacheStrategy } from "./types";

export type AnthropicModelMetadataLookup = (
	model: SupportedChatModel
) => ModelMetadataEntry | undefined;

export const createAnthropicPromptCacheStrategy = (
	modelMetadataFor: AnthropicModelMetadataLookup
): ModelProtocolPromptCacheStrategy => ({
	canWarmRequest: true,
	routeForModel: (model) => {
		const capabilities = modelMetadataFor(model)?.promptCache;
		if (!capabilities) {
			return;
		}
		const retentionTiers = capabilities.explicit.retentionTiers;
		const isRetentionSupported = (
			retention: SupportedPromptCacheRetentionTier
		): boolean => retentionTiers.includes(retention);
		return {
			hasControls: retentionTiers.length > 0,
			isRetentionSupported,
			retentionTtlMsFor: (retention) => {
				if (!isRetentionSupported(retention)) {
					return;
				}
				return retention === "short" ? 5 * 60_000 : 60 * 60_000;
			},
		};
	},
});
