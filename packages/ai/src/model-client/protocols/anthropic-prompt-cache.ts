import type { SupportedPromptCacheRetentionTier } from "../../model-metadata";
import { modelPromptCacheCapabilitiesFor } from "../../prompt-cache-metadata";
import type { ModelProtocolPromptCacheStrategy } from "./types";

export const anthropicPromptCacheStrategy: ModelProtocolPromptCacheStrategy = {
	canWarmRequest: true,
	routeForModel: (model) => {
		const capabilities = modelPromptCacheCapabilitiesFor(model);
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
};
