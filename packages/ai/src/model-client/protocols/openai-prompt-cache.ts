import type {
	OpenAIPromptCacheProtocol,
	SupportedPromptCacheRetentionTier,
} from "../../model-metadata";
import type { ModelTarget } from "../../model-target";
import type { SupportedChatModel } from "../../models";
import { getOpenAIPromptCacheProtocolCapabilities } from "../../prompt-cache";

export type OpenAIPromptCacheControls = Readonly<{
	breakpoints: boolean;
	promptCacheKey?: string;
	retentionField?: "prompt_cache_options.ttl" | "prompt_cache_retention";
	retentionValue?: string;
}>;

/** Resolves request controls against both policy and the selected Model Protocol metadata. */
export const openAIPromptCacheControlsForRequest = (
	model: SupportedChatModel,
	protocol: OpenAIPromptCacheProtocol,
	target: ModelTarget,
	promptCacheKey: string | undefined
): OpenAIPromptCacheControls => {
	if (target.promptCacheEnabled !== true) {
		return { breakpoints: false };
	}
	const capabilities = getOpenAIPromptCacheProtocolCapabilities(
		model,
		protocol
	);
	if (!capabilities || capabilities.eligibility.minimumInputTokens <= 0) {
		return { breakpoints: false };
	}
	const retentionTier: SupportedPromptCacheRetentionTier | undefined =
		target.promptCacheRetention;
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
