import { describe, expect, test } from "bun:test";
import {
	GLOB_DEFAULT_LIMIT,
	GLOB_MAX_LIMIT,
	globInputSchema,
	globOutputSchema,
} from "./schema";

describe("glob schema", () => {
	test("requires a pattern and accepts discovery controls", () => {
		expect(
			globInputSchema.safeParse({
				includeIgnored: true,
				includeHidden: true,
				limit: GLOB_DEFAULT_LIMIT,
				path: "src",
				pattern: "**/*.ts",
			}).success
		).toBe(true);
		expect(globInputSchema.safeParse({}).success).toBe(false);
	});

	test("bounds the result limit at 200 files", () => {
		expect(GLOB_DEFAULT_LIMIT).toBe(200);
		expect(GLOB_MAX_LIMIT).toBe(200);
		expect(globInputSchema.safeParse({ pattern: "*", limit: 0 }).success).toBe(
			false
		);
		expect(
			globInputSchema.safeParse({ pattern: "*", limit: GLOB_MAX_LIMIT + 1 })
				.success
		).toBe(false);
	});

	test("validates structured path results", () => {
		expect(
			globOutputSchema.safeParse({ paths: ["src/index.ts"] }).success
		).toBe(true);
		expect(
			globOutputSchema.safeParse({ paths: ["src/index.ts"], truncated: true })
				.success
		).toBe(true);
	});
});
