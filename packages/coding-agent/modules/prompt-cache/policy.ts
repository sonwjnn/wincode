import type {
	SupportedChatModel,
	SupportedPromptCacheRetentionTier,
} from "@wincode/ai/models";
import {
	promptCachePolicySchema,
	resolvePromptCacheRetention,
} from "@wincode/ai/models";

/** Resolves the optional `promptCache` settings block for one selected Model. */
export const resolveConfiguredPromptCacheRetention = (
	model: SupportedChatModel,
	settings: unknown
): SupportedPromptCacheRetentionTier | undefined => {
	if (settings === undefined) {
		return resolvePromptCacheRetention(model);
	}
	const parsed = promptCachePolicySchema.safeParse(settings);
	return parsed.success
		? resolvePromptCacheRetention(model, parsed.data)
		: undefined;
};
