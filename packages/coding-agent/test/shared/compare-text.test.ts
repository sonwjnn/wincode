import { expect, test } from "bun:test";
import { compareText } from "@/shared/utils/compare-text";

test("deterministic text ordering does not depend on locale collation", () => {
	expect(["b", "ä", "a", "A"].toSorted(compareText)).toEqual([
		"A",
		"a",
		"b",
		"ä",
	]);
	expect(compareText("same", "same")).toBe(0);
});
