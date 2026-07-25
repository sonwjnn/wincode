import { describe, expect, test } from "bun:test";
import { billingSuccessSearchSchema } from "./billing-success-search";

describe("billing success search", () => {
	test("validates an optional checkout reference without deriving status", () => {
		expect(
			billingSuccessSearchSchema.parse({ checkout_id: "checkout_reference" })
		).toEqual({ checkout_id: "checkout_reference" });
		expect(billingSuccessSearchSchema.parse({})).toEqual({});
	});

	test("rejects an empty checkout reference", () => {
		expect(() =>
			billingSuccessSearchSchema.parse({ checkout_id: "" })
		).toThrow();
	});
});
