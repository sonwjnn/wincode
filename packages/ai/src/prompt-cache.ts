import { z } from "zod";
import type { SupportedChatModel } from "./catalog";
import type {
	PromptCacheRetentionTier,
	SupportedPromptCacheRetentionTier,
} from "./model-metadata";
import { getModelMetadata } from "./model-metadata-runtime";

export type PromptCachePolicy = Readonly<{
	/** Per-model override; omitted models use the short default. */
	modelOverrides?: Readonly<Record<string, PromptCacheRetentionTier>>;
}>;

export const DEFAULT_PROMPT_CACHE_POLICY: PromptCachePolicy = {
	modelOverrides: {},
};

export const promptCachePolicySchema = z
	.object({
		modelOverrides: z
			.record(z.string(), z.enum(["short", "long", "off"]))
			.optional(),
	})
	.strict() satisfies z.ZodType<PromptCachePolicy>;

export const isSupportedPromptCacheRetention = (
	model: SupportedChatModel,
	retention: SupportedPromptCacheRetentionTier | undefined
): retention is SupportedPromptCacheRetentionTier =>
	retention !== undefined &&
	(getModelMetadata(model)?.promptCache?.explicit.retentionTiers.includes(
		retention
	) ??
		false);

/** Resolves a configured model override against that model's declared support. */
export const resolvePromptCacheRetention = (
	model: SupportedChatModel,
	policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY
): SupportedPromptCacheRetentionTier | undefined => {
	const key = `${model.connectionProviderId}/${model.id}`;
	const requested = policy.modelOverrides?.[key] ?? "short";
	if (requested === "off") {
		return;
	}
	return isSupportedPromptCacheRetention(model, requested)
		? requested
		: undefined;
};
