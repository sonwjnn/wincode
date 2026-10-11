import { z } from "zod";
import type { SupportedChatModel } from "./catalog";
import type {
	OpenAIPromptCacheProtocol,
	PromptCacheRetentionTier,
	SupportedPromptCacheRetentionTier,
} from "./model-metadata";
import { getModelMetadata } from "./model-metadata-runtime";

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

/** Resolves the OpenAI Model Protocol declared by the selected Model Catalog entry. */
export const openAIPromptCacheProtocolForModel = (
	model: SupportedChatModel
): OpenAIPromptCacheProtocol | undefined => {
	if (model.provider === "openai") {
		return "openai-responses";
	}
	if (model.provider !== "opencode-go") {
		return;
	}
	switch (model.protocol) {
		case "openai":
			return "openai-responses";
		case "openai-compatible":
			return "openai-chat";
		case "anthropic":
			return;
		default:
			return;
	}
};

/** Returns only cache controls declared for the selected model's OpenAI protocol. */
export const getOpenAIPromptCacheProtocolCapabilities = (
	model: SupportedChatModel,
	protocol: OpenAIPromptCacheProtocol
) => getModelMetadata(model)?.promptCache?.protocols?.[protocol];

/** Whether metadata declares any Wincode-controlled cache option for this route. */
export const supportsPromptCacheControls = (
	model: SupportedChatModel
): boolean => {
	const capabilities = getModelMetadata(model)?.promptCache;
	if (!capabilities) {
		return false;
	}
	if (
		model.provider === "anthropic" ||
		(model.provider === "opencode-go" && model.protocol === "anthropic")
	) {
		return capabilities.explicit.retentionTiers.length > 0;
	}
	const protocol = openAIPromptCacheProtocolForModel(model);
	if (!protocol) {
		return false;
	}
	const protocolCapabilities = capabilities.protocols?.[protocol];
	return (
		protocolCapabilities?.promptCacheKey === true ||
		protocolCapabilities?.breakpoints === true ||
		protocolCapabilities?.retention !== undefined
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
	const capabilities = getModelMetadata(model)?.promptCache;
	if (!capabilities) {
		return false;
	}
	if (
		model.provider === "anthropic" ||
		(model.provider === "opencode-go" && model.protocol === "anthropic")
	) {
		return capabilities.explicit.retentionTiers.includes(retention);
	}
	const protocol = openAIPromptCacheProtocolForModel(model);
	return (
		protocol !== undefined &&
		capabilities.protocols?.[protocol]?.retention?.values[retention] !==
			undefined
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

/** Resolves a configured retention override, constrained by declared capability. */
export const resolvePromptCacheRetention = (
	model: SupportedChatModel,
	policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY
): SupportedPromptCacheRetentionTier | undefined =>
	resolvePromptCacheControls(model, policy).retention;
