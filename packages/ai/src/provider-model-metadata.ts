import type {
	ModelMetadataEntry,
	OpenAIPromptCacheProtocol,
	SupportedPromptCacheRetentionTier,
	ThinkingLevel,
} from "./model-metadata.ts";
import { parsePromptCacheTtlMs } from "./prompt-cache-ttl.ts";
import type { ChatReasoningEffort, ProviderModel } from "./sdk.ts";

const addExplicitOffEffort = (
	policy: NonNullable<ModelMetadataEntry["thinking"]>,
	efforts: Set<ChatReasoningEffort>
): void => {
	const offMapValue = policy.levelMap?.off;
	if (offMapValue === null) {
		return;
	}
	if (
		policy.toggle === true ||
		policy.levels?.includes("off") ||
		offMapValue !== undefined
	) {
		efforts.add("none");
	}
};

const addNamedReasoningEfforts = (
	policy: NonNullable<ModelMetadataEntry["thinking"]>,
	efforts: Set<ChatReasoningEffort>
): void => {
	if (policy.unlevelled) {
		return;
	}
	for (const level of policy.levels ?? []) {
		if (level !== "off") {
			efforts.add(level);
		}
	}
	for (const level of Object.keys(policy.levelMap ?? {}) as ThinkingLevel[]) {
		if (level === "off") {
			continue;
		}
		const nativeValue = policy.levelMap?.[level];
		if (nativeValue === undefined) {
			continue;
		}
		if (nativeValue === null) {
			efforts.delete(level);
		} else {
			efforts.add(level);
		}
	}
};

const promptCacheRetentionTtlMsFor = (
	model: ProviderModel,
	metadata: ModelMetadataEntry | undefined
): ProviderModel["promptCacheRetentionTtlMs"] => {
	if (
		model.protocolId !== "openai-chat" &&
		model.protocolId !== "openai-responses"
	) {
		return;
	}
	const protocol = model.protocolId as OpenAIPromptCacheProtocol;
	const retention = metadata?.promptCache?.protocols?.[protocol]?.retention;
	if (retention === undefined) {
		return;
	}
	const ttlMs: Partial<Record<SupportedPromptCacheRetentionTier, number>> = {};
	for (const tier of ["short", "long"] as const) {
		const value = retention.values[tier];
		if (value !== undefined) {
			const ttl = parsePromptCacheTtlMs(value);
			if (ttl !== undefined) {
				ttlMs[tier] = ttl;
			}
		}
	}
	return Object.keys(ttlMs).length === 0 ? undefined : ttlMs;
};

const limitsFor = (
	metadata: ModelMetadataEntry | undefined
): ProviderModel["limits"] => {
	const limits = metadata?.limits;
	if (limits === undefined) {
		return;
	}
	return {
		contextWindowTokens: limits.context,
		...(limits.output === undefined ? {} : { maxOutputTokens: limits.output }),
	};
};

const pricingFor = (
	metadata: ModelMetadataEntry | undefined
): ProviderModel["pricing"] => {
	const cost = metadata?.cost;
	const tiers = metadata?.tiers;
	if (cost === undefined && tiers === undefined) {
		return;
	}
	return {
		...(cost === undefined
			? {}
			: {
					inputPerMillionTokensUsd: cost.input,
					outputPerMillionTokensUsd: cost.output,
					...(cost.cacheRead === undefined
						? {}
						: { cacheReadPerMillionTokensUsd: cost.cacheRead }),
					...(cost.cacheWrite === undefined
						? {}
						: { cacheWritePerMillionTokensUsd: cost.cacheWrite }),
				}),
		...(tiers === undefined || tiers.length === 0
			? {}
			: {
					tiers: tiers.map((tier) => ({
						inputTokensAbove: tier.inputTokensAbove,
						inputPerMillionTokensUsd: tier.input,
						outputPerMillionTokensUsd: tier.output,
						...(tier.cacheRead === undefined
							? {}
							: { cacheReadPerMillionTokensUsd: tier.cacheRead }),
						...(tier.cacheWrite === undefined
							? {}
							: { cacheWritePerMillionTokensUsd: tier.cacheWrite }),
					})),
				}),
	};
};

const reasoningEffortsFor = (
	metadata: ModelMetadataEntry | undefined
): readonly ChatReasoningEffort[] | undefined => {
	const policy = metadata?.thinking;
	if (!policy) {
		return;
	}

	const efforts = new Set<ChatReasoningEffort>();
	addExplicitOffEffort(policy, efforts);
	addNamedReasoningEfforts(policy, efforts);
	return efforts.size > 0 ? [...efforts] : undefined;
};

/** Adds only exact limits, prices, reasoning, and prompt-cache metadata. */
export const withProviderModelMetadata = (
	model: ProviderModel,
	metadata: ModelMetadataEntry | undefined
): ProviderModel => {
	const reasoningEfforts =
		model.reasoningEfforts ?? reasoningEffortsFor(metadata);
	const promptCacheRetentionTiers =
		model.promptCacheRetentionTiers ??
		metadata?.promptCache?.explicit.retentionTiers;
	const promptCacheRetentionTtlMs =
		model.promptCacheRetentionTtlMs ??
		promptCacheRetentionTtlMsFor(model, metadata);
	const limits = model.limits ?? limitsFor(metadata);
	const pricing = model.pricing ?? pricingFor(metadata);
	return {
		...model,
		...(limits === undefined ? {} : { limits }),
		...(pricing === undefined ? {} : { pricing }),
		...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
		...(promptCacheRetentionTiers === undefined
			? {}
			: { promptCacheRetentionTiers }),
		...(promptCacheRetentionTtlMs === undefined
			? {}
			: { promptCacheRetentionTtlMs }),
	};
};
