import { describe, expect, test } from "bun:test";
import { hasInlineImageToken } from "./user-message";

describe("hasInlineImageToken", () => {
	test("recognizes editable image placeholders", () => {
		expect(hasInlineImageToken("Describe [Image 4] ")).toBe(true);
	});

	test("keeps legacy image messages eligible for indicators", () => {
		expect(hasInlineImageToken("Describe this screenshot")).toBe(false);
	});
});
