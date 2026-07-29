import { describe, expect, test } from "bun:test";
import { removeTriggerText } from "./escape-trigger";

describe("removeTriggerText", () => {
	test("removes whole command text", () => {
		expect(
			removeTriggerText("/abc", {
				end: 4,
				kind: "command",
				query: "abc",
				start: 0,
			})
		).toEqual({ text: "", cursorOffset: 0 });
	});

	test("removes only command trigger and preserves existing prompt", () => {
		expect(
			removeTriggerText(" //review keep this", {
				end: 2,
				kind: "command",
				query: "",
				start: 0,
			})
		).toEqual({ text: "/review keep this", cursorOffset: 0 });
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
