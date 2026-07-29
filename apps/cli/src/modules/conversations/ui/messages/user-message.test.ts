import { describe, expect, test } from "bun:test";
import { getAppliedSkill, hasInlineImageToken } from "./user-message";

describe("hasInlineImageToken", () => {
	test("recognizes editable image placeholders", () => {
		expect(hasInlineImageToken("Describe [Image 4] ")).toBe(true);
	});

	test("keeps legacy image messages eligible for indicators", () => {
		expect(hasInlineImageToken("Describe this screenshot")).toBe(false);
	});
});

describe("getAppliedSkill", () => {
	test("accepts complete skill metadata", () => {
		expect(
			getAppliedSkill({
				skill: {
					arguments: "focus",
					contentHash: "sha256:abc",
					instructions: "Review code",
					name: "review",
				},
			})
		).toEqual({
			arguments: "focus",
			contentHash: "sha256:abc",
			instructions: "Review code",
			name: "review",
		});
	});

	test("rejects missing or incomplete skill metadata", () => {
		expect(getAppliedSkill({ mode: "plan" })).toBeUndefined();
		expect(
			getAppliedSkill({ skill: { name: "review", arguments: "" } })
		).toBeUndefined();
	});
});
