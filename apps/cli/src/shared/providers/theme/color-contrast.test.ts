import { describe, expect, test } from "bun:test";
import { getContrastingTextColor, getContrastRatio } from "./color-contrast";
import { THEMES } from "./themes";

describe("getContrastingTextColor", () => {
	test("uses dark text on light selections", () => {
		expect(getContrastingTextColor("#ffffff")).toBe("black");
	});

	test("uses light text on dark selections", () => {
		expect(getContrastingTextColor("#111111")).toBe("white");
	});

	test.each([
		"#6366F1",
		"#717CB4",
	])("uses black for %s when it has stronger contrast", (selection) => {
		expect(getContrastingTextColor(selection)).toBe("black");
	});

	test("chooses the stronger text color for every built-in selection", () => {
		for (const theme of THEMES) {
			const selection = theme.colors.selection;
			const textColor = getContrastingTextColor(selection);
			const chosenRatio = getContrastRatio(selection, textColor);
			const otherColor = textColor === "black" ? "white" : "black";

			expect(chosenRatio).toBeGreaterThanOrEqual(4.5);
			expect(chosenRatio).toBeGreaterThanOrEqual(
				getContrastRatio(selection, otherColor)
			);
		}
	});

	test("uses dark text for an invalid color fallback", () => {
		expect(getContrastingTextColor("invalid")).toBe("black");
	});
});
