import { expect, test } from "bun:test";
import { getModelPricingEnv } from "@/modules/model-pricing/model-pricing-env";
import { createEnvironmentRestorer } from "./support/environment";

test("reads the offline override at call time, not import time", () => {
	const restoreEnvironment = createEnvironmentRestorer([
		"WINCODE_MODEL_PRICING_OFFLINE",
	]);
	process.env.WINCODE_MODEL_PRICING_OFFLINE = "true";
	try {
		// The static import above evaluated the module before this assignment.
		// A module-scope parse would report offline as false, and a test or
		// harness that sets the override late would issue a real pricing fetch.
		expect(getModelPricingEnv().WINCODE_MODEL_PRICING_OFFLINE).toBe(true);
	} finally {
		restoreEnvironment();
	}
});
