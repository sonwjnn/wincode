import { describe, expect, test } from "bun:test";
import { scrollCommandSelection } from "./scroll-command";

describe("scrollCommandSelection", () => {
	test("moves selection and viewport together so the row stays put", () => {
		expect(scrollCommandSelection(2, 0, "down", 12, 8)).toEqual({
			selectedIndex: 3,
			visibleStartIndex: 1,
		});
		expect(scrollCommandSelection(3, 1, "up", 12, 8)).toEqual({
			selectedIndex: 2,
			visibleStartIndex: 0,
		});
	});

	test("clamps at the bottom without wrapping", () => {
		expect(scrollCommandSelection(11, 4, "down", 12, 8)).toEqual({
			selectedIndex: 11,
			visibleStartIndex: 4,
		});
	});

	test("clamps at the top without wrapping", () => {
		expect(scrollCommandSelection(0, 0, "up", 12, 8)).toEqual({
			selectedIndex: 0,
			visibleStartIndex: 0,
		});
	});

	test("keeps the selected row inside the viewport at the edges", () => {
		expect(scrollCommandSelection(9, 2, "down", 10, 8)).toEqual({
			selectedIndex: 9,
			visibleStartIndex: 2,
		});
		expect(scrollCommandSelection(0, 2, "up", 10, 8)).toEqual({
			selectedIndex: 0,
			visibleStartIndex: 0,
		});
	});

	test("leaves an empty list untouched", () => {
		expect(scrollCommandSelection(0, 0, "down", 0, 8)).toEqual({
			selectedIndex: 0,
			visibleStartIndex: 0,
		});
	});
});
