import { describe, expect, test } from "bun:test";
import { billingUsageSchema } from "./api/get-billing-usage";
import {
	formatBillingUsage,
	formatUsdMicros,
	getNextReleaseAt,
} from "./format-billing-usage";
import { getBillingStatusLabel } from "./get-billing-status-label";

const usage = billingUsageSchema.parse({
	effectiveEligible: true,
	mode: "enforce",
	quotaUsdMicros: "10000000",
	remainingUsdMicros: "7500000",
	usedUsdMicros: "2500000",
	windowStartedAt: "2026-06-23T00:00:00.000Z",
});

describe("billing usage presentation", () => {
	test("validates API payloads", () => {
		expect(() =>
			billingUsageSchema.parse({ ...usage, usedUsdMicros: "1.2" })
		).toThrow();
	});

	test("formats USD micros without floating point math", () => {
		expect(formatUsdMicros("2500001")).toBe("$2.50");
	});

	test("shows compact Go usage, limit, and next release", () => {
		expect(formatBillingUsage(usage)).toBe("Go $2.50/$10.00 · next Jul 23");
		expect(getNextReleaseAt(usage.windowStartedAt).toISOString()).toBe(
			"2026-07-23T00:00:00.000Z"
		);
	});

	test("shows BYOK instead of funded usage for direct models", () => {
		expect(getBillingStatusLabel(false, { status: "ready", usage })).toBe(
			"BYOK"
		);
		expect(
			getBillingStatusLabel(true, { status: "unavailable", usage: null })
		).toBe("Go unavailable");
	});
});
