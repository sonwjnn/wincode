import { describe, expect, test } from "bun:test";
import { detectCommandTrigger, detectTrigger } from "./triggers";

describe("chat input controller triggers", () => {
	test("detects slash command query", () => {
		expect(detectCommandTrigger("/")).toEqual({
			end: 1,
			kind: "command",
			query: "",
			start: 0,
		});
		expect(detectCommandTrigger("/models")).toEqual({
			end: 7,
			kind: "command",
			query: "models",
			start: 0,
		});
	});

	test("ignores non-command and spaced command text", () => {
		expect(detectCommandTrigger("hello")).toBeNull();
		expect(detectCommandTrigger("/new session")).toBeNull();
	});

	test("detects active trigger with command priority", () => {
		expect(detectTrigger("/themes", 7)).toEqual({
			end: 7,
			kind: "command",
			query: "themes",
			start: 0,
		});
		expect(detectTrigger("hello", 5)).toBeNull();
	});

	test("detects a leading slash after optional whitespace", () => {
		expect(detectTrigger(" /", 2)).toEqual({
			end: 2,
			kind: "command",
			query: "",
			start: 0,
		});
		expect(detectTrigger("  /ski", 6)).toEqual({
			end: 6,
			kind: "command",
			query: "ski",
			start: 0,
		});
		expect(detectTrigger("prefix /", 8)).toBeNull();
	});

	test("detects file mention through mention grammar", () => {
		expect(detectTrigger("see @packages/foo now", 17)).toEqual({
			end: 17,
			kind: "file-mention",
			query: "packages/foo",
			start: 4,
		});
		expect(detectTrigger("hello foo@bar.com", 17)).toBeNull();
		expect(detectTrigger('"@packages/foo"', 14)).toBeNull();
	});
});
