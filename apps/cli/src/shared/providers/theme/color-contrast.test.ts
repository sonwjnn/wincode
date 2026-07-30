import { describe, expect, test } from "bun:test";
import { getContrastingTextColor } from "./color-contrast";

describe("getContrastingTextColor", () => {
	test("uses dark text on light selections", () => {
		expect(getContrastingTextColor("#ffffff")).toBe("black");
	});

	test("uses light text on dark selections", () => {
		expect(getContrastingTextColor("#111111")).toBe("white");
	});

	test("uses dark text for an invalid color fallback", () => {
		expect(getContrastingTextColor("invalid")).toBe("black");
	});
});
