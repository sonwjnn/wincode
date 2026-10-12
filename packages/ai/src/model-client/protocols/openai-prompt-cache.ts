import type {
	OpenAIPromptCacheProtocol,
	SupportedPromptCacheRetentionTier,
} from "../../model-metadata";
import type { ModelTarget } from "../../model-target";
import type { SupportedChatModel } from "../../models";
import { getOpenAIPromptCacheProtocolCapabilities } from "../../prompt-cache-metadata";
import type { ModelProtocolPromptCacheStrategy } from "./types";

export type OpenAIPromptCacheControls = Readonly<{
	breakpoints: boolean;
	promptCacheKey?: string;
	retentionField?: "prompt_cache_options.ttl" | "prompt_cache_retention";
	retentionValue?: string;
}>;

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

export const openAIPromptCacheStrategyFor = (
	protocol: OpenAIPromptCacheProtocol
): ModelProtocolPromptCacheStrategy => ({
	canWarmRequest: true,
	routeForModel: (model) => {
		const capabilities = getOpenAIPromptCacheProtocolCapabilities(
			model,
			protocol
		);
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
				return value === undefined
					? undefined
					: parseRetentionDurationMs(value);
			},
		};
	},
});

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
