import type { SupportedPromptCacheRetentionTier } from "../../model-metadata.ts";
import type { ModelProtocolPromptCacheStrategy } from "./types.ts";

export const googlePromptCacheStrategy: ModelProtocolPromptCacheStrategy = {
	canWarmRequest: false,
	routeForModel: (model) => {
		const capabilities =
			model.providerId === "google" ? model.promptCache : undefined;
		if (!capabilities) {
			return;
		}
		const cachedContent = capabilities.googleCachedContent;
		const isRetentionSupported = (
			retention: SupportedPromptCacheRetentionTier
		): boolean =>
			capabilities.explicit.retentionTiers.includes(retention) &&
			cachedContent?.ttl[retention] !== undefined;
		return {
			cachedContentTtlFor: (retention) =>
				isRetentionSupported(retention)
					? cachedContent?.ttl[retention]
					: undefined,
			hasControls: Object.keys(cachedContent?.ttl ?? {}).length > 0,
			isRetentionSupported,
			retentionTtlMsFor: () => undefined,
		};
	},
};
