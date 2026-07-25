import { describe, expect, it } from "bun:test";
import {
	billingPricebook,
	billingPricebookEffectiveDate,
	billingPricebookVersion,
	billingRuntimePairSchema,
	calculateNormalizedUsageUsdMicros,
	getBillingProviderModelSnapshot,
} from "./pricing";
import { decideSupportedUsageCost, normalizeBillingUsage } from "./service";

describe("billing service", () => {
	it("normalizes lifecycle usage", () => {
		expect(
			normalizeBillingUsage({
				provider: "openai",
				modelId: "gpt-5.4-mini",
				uncachedInputTokens: 12n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 0n,
				outputTokens: 8n,
				reasoningTokens: 0n,
				inputTokens: 12n,
				totalTokens: 20n,
				modality: "text",
			})
		).toEqual({
			provider: "openai",
			modelId: "gpt-5.4-mini",
			input: 12n,
			uncachedInput: 12n,
			cacheRead: 0n,
			cacheWrite: 0n,
			output: 8n,
			reasoning: 0n,
			total: 20n,
			modality: "text",
		});
	});

	it("rejects string coercion", () => {
		expect(
			normalizeBillingUsage({
				provider: "openai",
				modelId: "gpt-5.4-mini",
				uncachedInputTokens: 1n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 0n,
				inputTokens: "12",
				outputTokens: 8n,
				reasoningTokens: 0n,
				totalTokens: 9n,
				modality: "text",
			})
		).toBeNull();
	});

	it("rejects invalid runtime pair", () => {
		expect(
			normalizeBillingUsage({
				provider: "openai",
				modelId: "gemini-2.5-flash",
				uncachedInputTokens: 1n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 0n,
				inputTokens: 1n,
				outputTokens: 1n,
				reasoningTokens: 0n,
				totalTokens: 2n,
				modality: "text",
			})
		).toBeNull();
	});

	it("exports pricebook metadata", () => {
		expect(billingPricebook.version).toBe(billingPricebookVersion);
		expect(billingPricebook.effectiveDate).toBe(billingPricebookEffectiveDate);
		expect(
			getBillingProviderModelSnapshot(
				billingRuntimePairSchema.parse({
					provider: "openai",
					modelId: "gpt-5.4-mini",
				})
			)
		).toEqual({
			provider: "openai",
			modelId: "gpt-5.4-mini",
			inputMicrosPerMillionTokens: 750000n,
			cacheReadMicrosPerMillionTokens: 75000n,
			cacheWriteMicrosPerMillionTokens: 0n,
			outputMicrosPerMillionTokens: 4500000n,
			reasoningMicrosPerMillionTokens: 0n,
			version: billingPricebookVersion,
			effectiveDate: billingPricebookEffectiveDate,
		});
	});

	it("prices supported models deterministically", () => {
		expect(
			calculateNormalizedUsageUsdMicros(
				billingRuntimePairSchema.parse({
					provider: "openai",
					modelId: "gpt-5.4-mini",
				}),
				{
					provider: "openai",
					modelId: "gpt-5.4-mini",
					input: 2_000_000n,
					uncachedInput: 1_000_000n,
					cacheRead: 1_000_000n,
					cacheWrite: 0n,
					output: 1_000_000n,
					reasoning: 0n,
					total: 3_000_000n,
					modality: "text",
				}
			)
		).toBe(5_325_000n);
		expect(() =>
			calculateNormalizedUsageUsdMicros(
				billingRuntimePairSchema.parse({
					provider: "openai",
					modelId: "gpt-5.4-mini",
				}),
				{
					provider: "google",
					modelId: "gemini-2.5-flash",
					input: 2_000_000n,
					uncachedInput: 1_000_000n,
					cacheRead: 1_000_000n,
					cacheWrite: 0n,
					output: 1_000_000n,
					reasoning: 0n,
					total: 3_000_000n,
					modality: "text",
				}
			)
		).toThrow("invalid usage: model mismatch");
		expect(
			calculateNormalizedUsageUsdMicros(
				billingRuntimePairSchema.parse({
					provider: "google",
					modelId: "gemini-2.5-flash",
				}),
				{
					provider: "google",
					modelId: "gemini-2.5-flash",
					input: 2_000_000n,
					uncachedInput: 1_000_000n,
					cacheRead: 1_000_000n,
					cacheWrite: 0n,
					output: 1_000_000n,
					reasoning: 0n,
					total: 3_000_000n,
					modality: "text",
				}
			)
		).toBe(2_830_000n);
	});

	it("rejects unsupported model usage", () => {
		expect(
			decideSupportedUsageCost("other", {
				provider: "openai",
				modelId: "gpt-5.4-mini",
				uncachedInputTokens: 1n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 0n,
				inputTokens: 1n,
				outputTokens: 1n,
				reasoningTokens: 0n,
				totalTokens: 2n,
				modality: "text",
			})
		).toEqual({ allow: false, reason: "unsupported-model" });
	});

	it("rejects ambiguous or unsupported usage", () => {
		expect(
			normalizeBillingUsage({
				provider: "google",
				modelId: "gemini-2.5-flash",
				uncachedInputTokens: 1n,
				cacheReadTokens: 1n,
				cacheWriteTokens: 0n,
				inputTokens: 1n,
				outputTokens: 1n,
				reasoningTokens: 0n,
				totalTokens: 2n,
				modality: "audio",
			})
		).toBeNull();
		expect(
			normalizeBillingUsage({
				provider: "openai",
				modelId: "gpt-5.4-mini",
				uncachedInputTokens: 2n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 0n,
				inputTokens: 1n,
				outputTokens: 1n,
				reasoningTokens: 0n,
				totalTokens: 2n,
				modality: "text",
			})
		).toBeNull();
		expect(
			normalizeBillingUsage({
				provider: "google",
				modelId: "gemini-2.5-flash",
				uncachedInputTokens: 1n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 0n,
				inputTokens: 1n,
				outputTokens: 1n,
				reasoningTokens: 2n,
				totalTokens: 3n,
				modality: "text",
			})
		).toBeNull();
		expect(
			normalizeBillingUsage({
				provider: "openai",
				modelId: "gpt-5.4-mini",
				uncachedInputTokens: 1n,
				cacheReadTokens: 0n,
				cacheWriteTokens: 1n,
				inputTokens: 1n,
				outputTokens: 1n,
				reasoningTokens: 0n,
				totalTokens: 2n,
				modality: "text",
			})
		).toBeNull();
	});
});
