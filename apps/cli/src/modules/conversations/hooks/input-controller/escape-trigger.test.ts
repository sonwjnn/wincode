import { describe, expect, test } from "bun:test";
import { removeTriggerText } from "./escape-trigger";

describe("removeTriggerText", () => {
	test("removes whole command text", () => {
		expect(
			removeTriggerText("/abc", { kind: "command", query: "abc" })
		).toEqual({ text: "", cursorOffset: null });
	});

	test("removes mention range and preserves surrounding text", () => {
		expect(
			removeTriggerText("prefix @src/file suffix", {
				kind: "file-mention",
				query: "src/file",
				start: 7,
				end: 16,
			})
		).toEqual({ text: "prefix  suffix", cursorOffset: 7 });
	});
});
