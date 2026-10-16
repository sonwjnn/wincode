import { openAIPromptCacheByModelId } from "../../generated/openai-prompt-cache.generated.ts";
import type {
	OpenAIPromptCacheProtocol,
	SupportedPromptCacheRetentionTier,
} from "../../model-metadata.ts";
import { parsePromptCacheTtlMs } from "../../prompt-cache-ttl.ts";
import type { ProviderModel } from "../../sdk.ts";
import type { ProviderProtocolRequest } from "./request.ts";
import type { ModelProtocolPromptCacheStrategy } from "./types";

export type OpenAIPromptCacheControls = Readonly<{
	breakpoints: boolean;
	promptCacheKey?: string;
	retentionField?: "prompt_cache_options.ttl" | "prompt_cache_retention";
	retentionValue?: string;
}>;

const openAIPromptCacheCapabilitiesFor = (
	model: ProviderModel,
	protocol: OpenAIPromptCacheProtocol
) =>
	model.providerId === "openai"
		? openAIPromptCacheByModelId[model.modelId]?.[protocol]
		: undefined;

export const openAIPromptCacheStrategyFor = (
	protocol: OpenAIPromptCacheProtocol
): ModelProtocolPromptCacheStrategy => ({
	canWarmRequest: true,
	routeForModel: (model) => {
		const capabilities = openAIPromptCacheCapabilitiesFor(model, protocol);
		if (!capabilities) {
			return;
		}
		return {
			hasControls:
				capabilities.promptCacheKey === true ||
				capabilities.breakpoints === true ||
				capabilities.retention !== undefined,
			isRetentionSupported: (retention) =>
				capabilities.retention?.values[retention] !== undefined,
			retentionTtlMsFor: (retention) => {
				const value = capabilities.retention?.values[retention];
				return value === undefined ? undefined : parsePromptCacheTtlMs(value);
			},
		};
	},
});

/** Resolves request controls against both policy and the selected Model Protocol metadata. */
export const openAIPromptCacheControlsForRequest = (
	model: ProviderModel,
	protocol: OpenAIPromptCacheProtocol,
	request: Pick<
		ProviderProtocolRequest,
		"promptCacheEnabled" | "promptCacheRetention"
	>,
	promptCacheKey: string | undefined
): OpenAIPromptCacheControls => {
	if (request.promptCacheEnabled !== true) {
		return { breakpoints: false };
	}
	const capabilities = openAIPromptCacheCapabilitiesFor(model, protocol);
	if (!capabilities || capabilities.eligibility.minimumInputTokens <= 0) {
		return { breakpoints: false };
	}
	const retentionTier: SupportedPromptCacheRetentionTier | undefined =
		request.promptCacheRetention;
	const retentionValue =
		retentionTier === undefined
			? undefined
			: capabilities.retention?.values[retentionTier];
	return {
		breakpoints: capabilities.breakpoints === true,
		...(capabilities.promptCacheKey === true && promptCacheKey !== undefined
			? { promptCacheKey }
			: {}),
		...(retentionValue === undefined || capabilities.retention === undefined
			? {}
			: {
					retentionField: capabilities.retention.field,
					retentionValue,
				}),
	};
};
