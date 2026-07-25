import { describe, expect, it } from "bun:test";
import {
	billingServerConfigSchema,
	canEnforceGoBilling,
	getEffectiveBillingMode,
} from "./server";

describe("billing server config", () => {
	it("defaults to disabled when go config absent", () => {
		const config = billingServerConfigSchema.parse({});

		expect(getEffectiveBillingMode(config)).toBe("disabled");
		expect(canEnforceGoBilling(config)).toBe(false);
	});

	it("parses allowlists and kill switches", () => {
		const config = billingServerConfigSchema.parse({
			alphaUserAllowlist: "a,b, c",
			modelKillSwitches: "m1",
			providerKillSwitches: "p1,p2",
		});

		expect(config.alphaUserAllowlist).toEqual(new Set(["a", "b", "c"]));
		expect(config.modelKillSwitches).toEqual(new Set(["m1"]));
		expect(config.providerKillSwitches).toEqual(new Set(["p1", "p2"]));
	});

	it("rejects canonical invalid usage fields", () => {
		expect(() =>
			billingServerConfigSchema.parse({
				mode: "allowlist-shadow",
				dailyGlobalCostCapUsdMicros: 1,
				priceBookVersion: "2026-07-19",
				priceBookEffectiveDate: "2026-07-19",
				fundedRequestInputTokenLimit: 1,
				fundedRequestOutputTokenLimit: 1,
				fundedRequestStepLimit: 1,
				fundedRequestTimeWindowSeconds: 1,
			})
		).toThrow();
	});

	it("rejects zero funded limits", () => {
		expect(() =>
			billingServerConfigSchema.parse({
				mode: "allowlist-shadow",
				alphaUserAllowlist: "u1",
				dailyGlobalCostCapUsdMicros: 1,
				priceBookVersion: "2026-07-19",
				priceBookEffectiveDate: "2026-07-19",
				fundedRequestInputTokenLimit: 0,
				fundedRequestOutputTokenLimit: 1,
				fundedRequestStepLimit: 1,
				fundedRequestTimeWindowSeconds: 1,
			})
		).toThrow();
	});

	it("accepts valid shadow config", () => {
		expect(
			billingServerConfigSchema.parse({
				mode: "allowlist-shadow",
				alphaUserAllowlist: "u1",
				dailyGlobalCostCapUsdMicros: 1,
				priceBookVersion: "2026-07-19",
				priceBookEffectiveDate: "2026-07-19",
				fundedRequestInputTokenLimit: 1,
				fundedRequestOutputTokenLimit: 1,
				fundedRequestStepLimit: 1,
				fundedRequestTimeWindowSeconds: 1,
			}).mode
		).toBe("allowlist-shadow");
	});

	it("requires polar for enforce modes", () => {
		expect(() =>
			billingServerConfigSchema.parse({
				mode: "enforce",
				goProductId: "prod_123",
				goRollingQuotaUsdMicros: 2,
				fundedRequestTimeWindowSeconds: 10,
				dailyGlobalCostCapUsdMicros: 1,
				fundedRequestInputTokenLimit: 1,
				fundedRequestOutputTokenLimit: 1,
				fundedRequestStepLimit: 1,
				priceBookVersion: "2026-07-19",
				priceBookEffectiveDate: "2026-07-19",
			})
		).toThrow();
	});

	it("accepts disabled startup", () => {
		expect(billingServerConfigSchema.parse({ mode: "disabled" }).mode).toBe(
			"disabled"
		);
	});
});
