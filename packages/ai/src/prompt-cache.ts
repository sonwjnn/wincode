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

type PromptCacheRoute = Readonly<{
	cachedContentTtlFor?: (
		retention: SupportedPromptCacheRetentionTier
	) => string | undefined;
	hasControls: boolean;
	isRetentionSupported: (
		retention: SupportedPromptCacheRetentionTier
	) => boolean;
	retentionTtlMsFor: (
		retention: SupportedPromptCacheRetentionTier
	) => number | undefined;
}>;

/** Resolves provider-specific cache behavior once from the selected model route. */
const promptCacheRouteForModel = (
	model: SupportedChatModel
): PromptCacheRoute | undefined => {
	const capabilities = getModelMetadata(model)?.promptCache;
	if (!capabilities) {
		return;
	}
	if (
		model.provider === "anthropic" ||
		(model.provider === "opencode-go" && model.protocol === "anthropic")
	) {
		const retentionTiers = capabilities.explicit.retentionTiers;
		const isRetentionSupported = (
			retention: SupportedPromptCacheRetentionTier
		): boolean => retentionTiers.includes(retention);
		return {
			hasControls: retentionTiers.length > 0,
			isRetentionSupported,
			retentionTtlMsFor: (retention) => {
				if (!isRetentionSupported(retention)) {
					return;
				}
				return retention === "short" ? 5 * 60_000 : 60 * 60_000;
			},
		};
	}
	if (model.provider === "google") {
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
	}
	const protocol = openAIPromptCacheProtocolForModel(model);
	const protocolCapabilities =
		protocol === undefined ? undefined : capabilities.protocols?.[protocol];
	if (protocolCapabilities === undefined) {
		return;
	}
	return {
		hasControls:
			protocolCapabilities.promptCacheKey === true ||
			protocolCapabilities.breakpoints === true ||
			protocolCapabilities.retention !== undefined,
		isRetentionSupported: (retention) =>
			protocolCapabilities.retention?.values[retention] !== undefined,
		retentionTtlMsFor: (retention) => {
			const value = protocolCapabilities.retention?.values[retention];
			return value === undefined ? undefined : parseRetentionDurationMs(value);
		},
	};
};

const RETENTION_DURATION_PATTERN = /^(\d+)(s|m|h)$/u;

const parseRetentionDurationMs = (value: string): number | undefined => {
	const parsed = RETENTION_DURATION_PATTERN.exec(value);
	if (parsed === null) {
		return;
	}
	const amount = Number(parsed[1]);
	let unitMs: number;
	if (parsed[2] === "s") {
		unitMs = 1000;
	} else if (parsed[2] === "m") {
		unitMs = 60_000;
	} else {
		unitMs = 60 * 60_000;
	}
	return Number.isSafeInteger(amount) && amount > 0
		? amount * unitMs
		: undefined;
};

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
