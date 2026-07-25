import { describe, expect, it } from "bun:test";
import { billingServerConfigSchema } from "@wincode/billing/server";

describe("billing config adapter shape", () => {
	it("matches repo-required names", () => {
		expect(
			billingServerConfigSchema.parse({
				mode: "disabled",
				fundedRequestInputTokenLimit: 1,
				fundedRequestOutputTokenLimit: 1,
				fundedRequestStepLimit: 1,
				fundedRequestTimeWindowSeconds: 1,
			})
		).toMatchObject({
			fundedRequestInputTokenLimit: 1n,
			fundedRequestOutputTokenLimit: 1n,
			fundedRequestStepLimit: 1n,
			fundedRequestTimeWindowSeconds: 1n,
		});
	});
});
