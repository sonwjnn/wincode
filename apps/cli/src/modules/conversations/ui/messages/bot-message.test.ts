import { describe, expect, mock, test } from "bun:test";

mock.module("@wincode/ai", () => ({
	findSupportedChatModelSelection: () => null,
	normalizeChatModelSelection: (
		selection: string | { modelId: string; providerId: string }
	) =>
		typeof selection === "string"
			? { modelId: selection, providerId: "wincode" }
			: selection,
}));

const { formatResponseTime } = await import("./bot-message");

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

	test("keeps footer data available for interrupted turns", () => {
		expect(formatResponseTime(1001)).toBe("1.0s");
	});
});
