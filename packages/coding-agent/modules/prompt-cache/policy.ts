import type {
	ResolvedPromptCacheControls,
	SupportedChatModel,
	SupportedPromptCacheRetentionTier,
} from "@wincode/ai/models";
import {
	promptCachePolicySchema,
	resolvePromptCacheControls,
} from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";

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
export const resolveProviderPromptCacheControls = (
	model: ProviderModel,
	settings: unknown
): ResolvedPromptCacheControls => {
	const supportedTiers = model.promptCacheRetentionTiers;
	if (supportedTiers === undefined || supportedTiers.length === 0) {
		return { enabled: false };
	}
	const parsed = promptCachePolicySchema.safeParse(settings ?? {});
	if (!parsed.success) {
		return { enabled: false };
	}
	const key = `${model.providerId}/${model.modelId}`;
	const requested = parsed.data.modelOverrides?.[key] ?? "short";
	if (requested === "off" || !supportedTiers.includes(requested)) {
		return { enabled: false };
	}
	return { enabled: true, retention: requested };
};

export const resolveConfiguredPromptCacheRetention = (
	model: SupportedChatModel,
	settings: unknown
): SupportedPromptCacheRetentionTier | undefined =>
	resolveConfiguredPromptCacheControls(model, settings).retention;
