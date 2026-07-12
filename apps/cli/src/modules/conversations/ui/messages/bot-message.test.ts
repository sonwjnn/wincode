import { describe, expect, test } from "bun:test";
import { formatResponseTime } from "./bot-message";

describe("formatResponseTime", () => {
	test("formats sub-second durations in milliseconds", () => {
		expect(formatResponseTime(431)).toBe("431ms");
	});

	test("formats seconds with one decimal place", () => {
		expect(formatResponseTime(4300)).toBe("4.3s");
	});

	test("formats minute durations with seconds", () => {
		expect(formatResponseTime(159_000)).toBe("2m 39s");
	});
});
