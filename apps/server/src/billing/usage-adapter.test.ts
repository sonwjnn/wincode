import { describe, expect, it } from "bun:test";
import { adaptBillingUsage, buildBillingStepId } from "./usage-adapter";

describe("billing usage adapter", () => {
	it("builds deterministic step ids", () => {
		expect(buildBillingStepId("r1", 0)).toBe("billing:r1:0");
	});

	it("settles when cache write is undefined", () => {
		expect(
			adaptBillingUsage("r1", 1, {
				provider: "openai",
				modelId: "gpt-5.4-mini",
				inputTokens: 100,
				inputTokenDetails: { cacheReadTokens: 25, cacheWriteTokens: undefined },
				outputTokens: 10,
				outputTokenDetails: { reasoningTokens: 3 },
				totalTokens: 110,
			})
		).toMatchObject({
			reconciliationRequired: false,
			usage: { cacheWrite: 0n },
		});
	});

	it("flags null cache fields for reconciliation", () => {
		expect(
			adaptBillingUsage("r1", 2, {
				provider: "openai",
				modelId: "gpt-5.4-mini",
				inputTokens: 10,
				inputTokenDetails: { cacheReadTokens: null, cacheWriteTokens: 0 },
				outputTokens: 1,
				outputTokenDetails: { reasoningTokens: null },
				totalTokens: 11,
			})
		).toMatchObject({
			reconciliationRequired: true,
			usage: null,
		});
	});

	it("preserves SDK event model identity", () => {
		expect(
			adaptBillingUsage("r1", 3, {
				provider: "openai",
				modelId: "gpt-5.4-mini",
				inputTokens: 4,
				inputTokenDetails: { cacheReadTokens: 1, cacheWriteTokens: 0 },
				outputTokens: 2,
				outputTokenDetails: { reasoningTokens: 0 },
				totalTokens: 6,
			})
		).toMatchObject({
			usage: { provider: "openai", modelId: "gpt-5.4-mini" },
		});
	});
});
