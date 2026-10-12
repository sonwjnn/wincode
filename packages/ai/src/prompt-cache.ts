import { z } from "zod";
import type { SupportedChatModel } from "./catalog";
import { modelProtocolStrategyFor } from "./model-client/provider-adapters";
import type {
	OpenAIPromptCacheProtocol,
	PromptCacheRetentionTier,
	SupportedPromptCacheRetentionTier,
} from "./model-metadata";

export { getOpenAIPromptCacheProtocolCapabilities } from "./prompt-cache-metadata";

export type PromptCachePolicy = Readonly<{
	/** Per-model override; omitted models use the short default. */
	modelOverrides?: Readonly<Record<string, PromptCacheRetentionTier>>;
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
			.record(z.string(), z.enum(["short", "long", "off"]))
			.optional(),
	})
	.strict() satisfies z.ZodType<PromptCachePolicy>;

/** Resolves the OpenAI Model Protocol selected by the provider adapter. */
export const openAIPromptCacheProtocolForModel = (
	model: SupportedChatModel
): OpenAIPromptCacheProtocol | undefined => {
	const protocol = modelProtocolStrategyFor(model).protocol;
	return protocol === "openai-chat" || protocol === "openai-responses"
		? protocol
		: undefined;
};

const promptCacheRouteForModel = (model: SupportedChatModel) =>
	modelProtocolStrategyFor(model).promptCache.routeForModel(model);

/** Returns a request-refreshable protocol's verified lifetime, never a guess. */
export const promptCacheRetentionTtlMsForModel = (
	model: SupportedChatModel,
	retention: SupportedPromptCacheRetentionTier | undefined
): number | undefined => {
	if (retention === undefined) {
		return;
	}
	const route = promptCacheRouteForModel(model);
	return route?.isRetentionSupported(retention)
		? route.retentionTtlMsFor(retention)
		: undefined;
};

/** Whether metadata declares any Wincode-controlled cache option for this route. */
export const supportsPromptCacheControls = (
	model: SupportedChatModel
): boolean => promptCacheRouteForModel(model)?.hasControls ?? false;

/** Whether this protocol supports a standalone request to establish a cache. */
export const supportsPromptCacheWarmingForModel = (
	model: SupportedChatModel
): boolean => {
	const strategy = modelProtocolStrategyFor(model).promptCache;
	return (
		strategy.canWarmRequest &&
		(strategy.routeForModel(model)?.hasControls ?? false)
	);
};

/** Whether the selected model's protocol declares this retention tier and wire value. */
export const isSupportedPromptCacheRetention = (
	model: SupportedChatModel,
	retention: SupportedPromptCacheRetentionTier | undefined
): retention is SupportedPromptCacheRetentionTier => {
	if (retention === undefined) {
		return false;
	}
	return (
		promptCacheRouteForModel(model)?.isRetentionSupported(retention) ?? false
	);
};

/** Resolves active cache controls and the requested tier against model metadata. */
export const resolvePromptCacheControls = (
	model: SupportedChatModel,
	policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY
): ResolvedPromptCacheControls => {
	const key = `${model.connectionProviderId}/${model.id}`;
	const requested = policy.modelOverrides?.[key] ?? "short";
	if (requested === "off" || !supportsPromptCacheControls(model)) {
		return { enabled: false };
	}
	return {
		enabled: true,
		...(isSupportedPromptCacheRetention(model, requested)
			? { retention: requested }
			: {}),
	};
};

/** Returns the exact Google CachedContent TTL documented for this model and tier. */
export const googleCachedContentTtlForModel = (
	model: SupportedChatModel,
	retention: SupportedPromptCacheRetentionTier | undefined
): string | undefined =>
	retention === undefined
		? undefined
		: promptCacheRouteForModel(model)?.cachedContentTtlFor?.(retention);

/** Resolves a configured retention override, constrained by declared capability. */
export const resolvePromptCacheRetention = (
	model: SupportedChatModel,
	policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY
): SupportedPromptCacheRetentionTier | undefined =>
	resolvePromptCacheControls(model, policy).retention;
