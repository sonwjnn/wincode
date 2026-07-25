import { z } from "zod";
import type { BillingNormalizedUsage } from "./pricing";
import {
	billingNormalizedUsageSchema,
	billingRuntimePairSchema,
	calculateNormalizedUsageUsdMicros,
	isSupportedBillingModel,
} from "./pricing";

const lifecycleUsageSchema = z
	.object({
		provider: z.enum(["openai", "google"]),
		modelId: z.enum(["gpt-5.4-mini", "gemini-2.5-flash"]),
		inputTokens: z.bigint(),
		uncachedInputTokens: z.bigint(),
		cacheReadTokens: z.bigint(),
		cacheWriteTokens: z.literal(0n),
		outputTokens: z.bigint(),
		reasoningTokens: z.bigint(),
		totalTokens: z.bigint(),
		modality: z.literal("text"),
	})
	.strict();

export const normalizeBillingUsage = (
	value: unknown
): BillingNormalizedUsage | null => {
	const parsed = lifecycleUsageSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const pair = billingRuntimePairSchema.safeParse({
		provider: parsed.data.provider,
		modelId: parsed.data.modelId,
	});
	if (!pair.success) {
		return null;
	}
	if (
		parsed.data.cacheWriteTokens !== 0n ||
		parsed.data.uncachedInputTokens + parsed.data.cacheReadTokens !==
			parsed.data.inputTokens ||
		parsed.data.reasoningTokens > parsed.data.outputTokens ||
		parsed.data.totalTokens !==
			parsed.data.inputTokens + parsed.data.outputTokens
	) {
		return null;
	}
	const normalized = billingNormalizedUsageSchema.safeParse({
		provider: parsed.data.provider,
		modelId: parsed.data.modelId,
		input: parsed.data.inputTokens,
		uncachedInput: parsed.data.uncachedInputTokens,
		cacheRead: parsed.data.cacheReadTokens,
		cacheWrite: parsed.data.cacheWriteTokens,
		output: parsed.data.outputTokens,
		reasoning: parsed.data.reasoningTokens,
		total: parsed.data.totalTokens,
		modality: parsed.data.modality,
	});
	return normalized.success ? normalized.data : null;
};

export type BillingDecision =
	| { allow: true; costUsdMicros: bigint }
	| { allow: false; reason: string };

export const decideSupportedUsageCost = (
	modelId: string,
	usage: unknown
): BillingDecision => {
	if (!isSupportedBillingModel(modelId)) {
		return { allow: false, reason: "unsupported-model" };
	}
	const normalized = normalizeBillingUsage(usage);
	if (!normalized) {
		return { allow: false, reason: "invalid-usage" };
	}
	const pair = billingRuntimePairSchema.safeParse({
		provider: normalized.provider,
		modelId: normalized.modelId,
	});
	if (!pair.success) {
		return { allow: false, reason: "invalid-usage" };
	}
	return {
		allow: true,
		costUsdMicros: calculateNormalizedUsageUsdMicros(pair.data, normalized),
	};
};
