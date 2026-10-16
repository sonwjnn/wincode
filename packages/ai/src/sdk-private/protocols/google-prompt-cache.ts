import { googleModelMetadataById } from "../../generated/google-model-metadata.generated.ts";
import type { SupportedPromptCacheRetentionTier } from "../../model-metadata";
import type { ModelProtocolPromptCacheStrategy } from "./types";

export const googlePromptCacheStrategy: ModelProtocolPromptCacheStrategy = {
	canWarmRequest: false,
	routeForModel: (model) => {
		const capabilities =
			model.providerId === "google"
				? googleModelMetadataById[model.modelId]?.promptCache
				: undefined;
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
