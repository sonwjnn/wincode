import type {
	ProviderModel,
	ResolvedPromptCacheControls,
	SupportedPromptCacheRetentionTier,
} from "@wincode/ai/sdk";
import {
	promptCachePolicySchema,
	resolvePromptCacheControls,
} from "@wincode/ai/sdk";

/** Resolves the optional `promptCache` settings block for one Provider Model. */
export const resolveConfiguredPromptCacheControls = (
	model: ProviderModel,
	settings: unknown
): ResolvedPromptCacheControls => {
	if (settings === undefined) {
		return resolvePromptCacheControls(model);
	}
	const parsed = promptCachePolicySchema.safeParse(settings);
	return parsed.success
		? resolvePromptCacheControls(model, parsed.data)
		: { enabled: false };
};

export const resolveConfiguredPromptCacheRetention = (
	model: ProviderModel,
	settings: unknown
): SupportedPromptCacheRetentionTier | undefined =>
	resolveConfiguredPromptCacheControls(model, settings).retention;
