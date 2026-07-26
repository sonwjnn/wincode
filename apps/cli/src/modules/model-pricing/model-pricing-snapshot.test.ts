import { describe, expect, test } from "bun:test";
import { supportedChatModelIds } from "@wincode/ai";
import { getHostedModelCost } from "./model-pricing";
import { modelPricingSnapshot } from "./model-pricing-snapshot.generated";

const SNAPSHOT_IDS_WITH_CONTEXT = new Set(
	Object.entries(modelPricingSnapshot)
		.filter(([, entry]) => entry.contextLimit > 0)
		.map(([key]) => key.split("/").slice(1).join("/"))
);

describe("model pricing snapshot", () => {
	test("every catalog id has a contextLimit in the snapshot", () => {
		for (const id of supportedChatModelIds) {
			expect(SNAPSHOT_IDS_WITH_CONTEXT.has(id)).toBe(true);
		}
	});

	test("hosted model snapshots agree with billingPricebook", () => {
		for (const id of ["gpt-5.4-mini", "gemini-2.5-flash"] as const) {
			const live =
				modelPricingSnapshot[`openai/${id}`]?.cost ??
				modelPricingSnapshot[`google/${id}`]?.cost;
			const expected = getHostedModelCost(id);
			expect(expected).toBeDefined();
			expect(live?.input).toBe(expected?.input);
			expect(live?.output).toBe(expected?.output);
		}
	});
});
