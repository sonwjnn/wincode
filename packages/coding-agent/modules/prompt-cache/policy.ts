import type {
	ResolvedPromptCacheControls,
	SupportedChatModel,
	SupportedPromptCacheRetentionTier,
} from "@wincode/ai/models";
import {
	promptCachePolicySchema,
	resolvePromptCacheControls,
} from "@wincode/ai/models";

/** Resolves the optional `promptCache` settings block for one selected Model. */
export const resolveConfiguredPromptCacheControls = (
	model: SupportedChatModel,
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

/** Resolves the retention-only view retained by existing policy callers. */
export const resolveConfiguredPromptCacheRetention = (
	model: SupportedChatModel,
	settings: unknown
): SupportedPromptCacheRetentionTier | undefined =>
	resolveConfiguredPromptCacheControls(model, settings).retention;
