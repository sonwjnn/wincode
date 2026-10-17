import { z } from "zod";
import {
	promptCacheRetentionTierSchema,
	type SupportedPromptCacheRetentionTier,
} from "./model-metadata.ts";
import type { ProviderModel } from "./sdk.ts";

export type PromptCachePolicy = Readonly<{
	/** Per-provider-model override; omitted models use the short default. */
	modelOverrides?: Readonly<
		Record<string, "off" | SupportedPromptCacheRetentionTier>
	>;
}>;

export type ResolvedPromptCacheControls = Readonly<{
	enabled: boolean;
	retention?: SupportedPromptCacheRetentionTier;
}>;

export const DEFAULT_PROMPT_CACHE_POLICY: PromptCachePolicy = {
	modelOverrides: {},
};

export const promptCachePolicySchema = z
	.object({
		modelOverrides: z
			.record(z.string(), promptCacheRetentionTierSchema)
			.optional(),
	})
	.strict() satisfies z.ZodType<PromptCachePolicy>;

/** Enables only cache retention tiers explicitly published by this Provider Model. */
export const resolvePromptCacheControls = (
	model: ProviderModel,
	policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY
): ResolvedPromptCacheControls => {
	const supportedTiers = model.promptCacheRetentionTiers;
	if (supportedTiers === undefined || supportedTiers.length === 0) {
		return { enabled: false };
	}
	const key = `${model.providerId}/${model.modelId}`;
	const requested = policy.modelOverrides?.[key] ?? "short";
	if (requested === "off") {
		return { enabled: false };
	}
	if (!supportedTiers.includes(requested)) {
		return { enabled: false };
	}
	return { enabled: true, retention: requested };
};
