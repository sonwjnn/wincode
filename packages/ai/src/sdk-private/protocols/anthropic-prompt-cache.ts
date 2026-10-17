import type { SupportedPromptCacheRetentionTier } from "../../model-metadata.ts";
import type { ModelProtocolPromptCacheStrategy } from "./types.ts";

export const createAnthropicPromptCacheStrategy =
	(): ModelProtocolPromptCacheStrategy => ({
		canWarmRequest: true,
		routeForModel: (model) => {
			const capabilities = model.promptCache;
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
