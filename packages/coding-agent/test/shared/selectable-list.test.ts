import { describe, expect, test } from "bun:test";
import { getSelectableListRange } from "@/shared/ui/selectable-list";

describe("getSelectableListRange", () => {
	test("keeps the selected row visible while centering a long list", () => {
		expect(getSelectableListRange(5, 12, 8)).toEqual({
			endIndex: 9,
			startIndex: 1,
		});
		expect(getSelectableListRange(11, 12, 8)).toEqual({
			endIndex: 12,
			startIndex: 4,
		});
	});

	test("clamps invalid selections and lists shorter than the viewport", () => {
		expect(getSelectableListRange(-1, 3, 8)).toEqual({
			endIndex: 3,
			startIndex: 0,
		});
		expect(getSelectableListRange(99, 3, 8)).toEqual({
			endIndex: 3,
			startIndex: 0,
		});
	});

	test("returns an empty range for an empty list", () => {
		expect(getSelectableListRange(0, 0, 8)).toEqual({
			endIndex: 0,
			startIndex: 0,
		});
	});
});
