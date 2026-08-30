import { describe, expect, test } from "bun:test";
import {
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	isElevatedResourceProfile,
	RESOURCE_LIMIT_PROFILES,
	resourceLimitProfileSchema,
	TOOL_RESOURCE_LIMITS,
} from "./resource-limits";

describe("tool resource profiles", () => {
	test("exposes standard, extended, and deep profiles", () => {
		expect(RESOURCE_LIMIT_PROFILES).toEqual(["standard", "extended", "deep"]);
		expect(DEFAULT_RESOURCE_LIMIT_PROFILE).toBe("standard");
		expect(resourceLimitProfileSchema.safeParse("extended").success).toBe(true);
		expect(resourceLimitProfileSchema.safeParse("unbounded").success).toBe(
			false
		);
	});

	test("keeps profiles monotonic while preserving the standard defaults", () => {
		const standard = getToolResourceLimits("standard");
		const extended = getToolResourceLimits("extended");
		const deep = getToolResourceLimits("deep");

		expect(standard).toEqual(TOOL_RESOURCE_LIMITS.standard);
		expect(standard.read.maxOutputBytes).toBe(50 * 1024);
		expect(standard.grep.maxMatches).toBe(1000);
		expect(standard.glob.maxCandidates).toBe(10_000);
		expect(standard.glob.maxDurationMs).toBe(5000);
		expect(standard.glob.maxOutputBytes).toBe(16 * 1024);
		expect(standard.shell.maxTimeoutSeconds).toBe(300);
		expect(extended.read.maxOutputBytes).toBeGreaterThan(
			standard.read.maxOutputBytes
		);
		expect(extended.glob.maxOutputBytes).toBeGreaterThan(
			standard.glob.maxOutputBytes
		);
		expect(deep.read.maxOutputBytes).toBeGreaterThan(
			extended.read.maxOutputBytes
		);
		expect(deep.grep.maxFiles).toBeGreaterThan(extended.grep.maxFiles);
		expect(deep.shell.maxOutputBytes).toBeGreaterThan(
			extended.shell.maxOutputBytes
		);
	});

	test("identifies profiles that require an approval", () => {
		expect(isElevatedResourceProfile("standard")).toBe(false);
		expect(isElevatedResourceProfile("extended")).toBe(true);
		expect(isElevatedResourceProfile("deep")).toBe(true);
	});
});
