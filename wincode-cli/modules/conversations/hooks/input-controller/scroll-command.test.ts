import { describe, expect, test } from "bun:test";
import { scrollCommandViewport } from "./scroll-command";

describe("scrollCommandViewport", () => {
	test("slides the viewport one row per scroll step", () => {
		expect(scrollCommandViewport(0, "down", 12, 8)).toBe(1);
		expect(scrollCommandViewport(1, "up", 12, 8)).toBe(0);
	});

	test("clamps at the top without moving", () => {
		expect(scrollCommandViewport(0, "up", 12, 8)).toBe(0);
	});

	test("clamps at the bottom without moving", () => {
		expect(scrollCommandViewport(4, "down", 12, 8)).toBe(4);
	});

	test("handles lists shorter than the viewport", () => {
		expect(scrollCommandViewport(0, "down", 3, 8)).toBe(0);
	});

	test("leaves an empty list untouched", () => {
		expect(scrollCommandViewport(0, "down", 0, 8)).toBe(0);
	});
});
