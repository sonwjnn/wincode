import { describe, expect, test } from "bun:test";
import {
	getHostedModelCost,
	modelPricingKey,
	resolveModelPricing,
} from "./model-pricing";

const TABLE = {
	"openai/gpt-5.4-mini": {
		contextLimit: 400_000,
		cost: { input: 0.25, output: 2 },
	},
	"openai/gpt-5.1-codex": { contextLimit: 400_000 },
	"google/gemma-4-31b-it": { contextLimit: 128_000 },
} as const;

describe("modelPricingKey", () => {
	test("joins provider and modelId with a slash", () => {
		expect(modelPricingKey("anthropic", "claude-sonnet-4-6")).toBe(
			"anthropic/claude-sonnet-4-6"
		);
	});
});

describe("getHostedModelCost", () => {
	test("maps billingPricebook micros to USD per million", () => {
		expect(getHostedModelCost("gpt-5.4-mini")).toEqual({
			input: 0.75,
			cacheRead: 0.075,
			output: 4.5,
		});
		expect(getHostedModelCost("gemini-2.5-flash")).toEqual({
			input: 0.3,
			cacheRead: 0.03,
			output: 2.5,
		});
	});

	test("returns undefined for ids that are not in the pricebook", () => {
		expect(getHostedModelCost("not-in-pricebook")).toBeUndefined();
	});
});

describe("resolveModelPricing", () => {
	test("returns direct price from the table for non-hosted models", () => {
		expect(
			resolveModelPricing(TABLE, {
				modelId: "gpt-5.4-mini",
				providerId: "openai",
			})
		).toEqual({
			contextLimit: 400_000,
			cost: { input: 0.25, output: 2 },
		});
	});

	test("prefers billingPricebook over the table for hosted models", () => {
		const TABLE_WITH_HOSTED = {
			...TABLE,
			"openai/gpt-5.4-mini": {
				contextLimit: 400_000,
				cost: { input: 99, output: 99 },
			},
		};
		expect(
			resolveModelPricing(TABLE_WITH_HOSTED, {
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toEqual({
			contextLimit: 400_000,
			cost: { input: 0.75, output: 4.5, cacheRead: 0.075 },
		});
	});

	test("returns an entry with no cost when the model has no price", () => {
		const result = resolveModelPricing(TABLE, {
			modelId: "gpt-5.1-codex",
			providerId: "openai",
		});
		expect(result).toEqual({ contextLimit: 400_000 });
		expect(result?.cost).toBeUndefined();
	});

	test("returns null when the model is not in the table", () => {
		expect(
			resolveModelPricing(TABLE, {
				modelId: "no-such-model",
				providerId: "openai",
			})
		).toBeNull();
	});

	test("returns null when the selection is unsupported by the catalog", () => {
		expect(
			resolveModelPricing(TABLE, {
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toBeNull();
	});
});
