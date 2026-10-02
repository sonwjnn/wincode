import { describe, expect, test } from "bun:test";
import { removeTriggerText } from "@/modules/sessions/hooks/input-controller/escape-trigger";

describe("removeTriggerText", () => {
	test("removes whole command text", () => {
		expect(
			removeTriggerText("/abc", {
				end: 4,
				kind: "command",
				mode: "root",
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
				mode: "root",
				query: "",
				start: 0,
			})
		).toEqual({ text: "/review keep this", cursorOffset: 0 });
	});

	test("keeps one space between the surviving prose", () => {
		expect(
			removeTriggerText("aaa /compact bbb", {
				end: 12,
				kind: "command",
				mode: "skill",
				query: "compact",
				start: 4,
			})
		).toEqual({ text: "aaa bbb", cursorOffset: 4 });
	});

	test("drops the preceding space when the trigger ends the prompt", () => {
		expect(
			removeTriggerText("aaa /compact", {
				end: 12,
				kind: "command",
				mode: "skill",
				query: "compact",
				start: 4,
			})
		).toEqual({ text: "aaa", cursorOffset: 3 });
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
