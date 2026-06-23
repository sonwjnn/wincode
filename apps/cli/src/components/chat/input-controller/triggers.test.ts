import { describe, expect, test } from "bun:test";
import {
	applyFileMentionReplacement,
	detectCommandTrigger,
	detectTrigger,
	replaceFileMentionTrigger,
} from "./triggers";

describe("chat input controller triggers", () => {
	test("detects slash command query", () => {
		expect(detectCommandTrigger("/")).toEqual({
			kind: "command",
			query: "",
		});
		expect(detectCommandTrigger("/models")).toEqual({
			kind: "command",
			query: "models",
		});
	});

	test("ignores non-command and spaced command text", () => {
		expect(detectCommandTrigger("hello")).toBeNull();
		expect(detectCommandTrigger("/new session")).toBeNull();
	});

	test("detects active trigger with command priority", () => {
		expect(detectTrigger("/theme", 6)).toEqual({
			kind: "command",
			query: "theme",
		});
		expect(detectTrigger("hello", 5)).toBeNull();
	});

	test("detects file mentions and ignores email and quoted text", () => {
		expect(detectTrigger("@packages/foo", 13)).toEqual({
			kind: "file-mention",
			query: "packages/foo",
			start: 0,
			end: 13,
		});
		expect(detectTrigger("hello foo@bar.com", 17)).toBeNull();
		expect(detectTrigger("'@packages/foo'", 14)).toBeNull();
		expect(detectTrigger('"@packages/foo"', 14)).toBeNull();
		expect(detectTrigger("`@packages/foo`", 14)).toBeNull();
		expect(detectTrigger("don't @packages/foo", 19)).toEqual({
			kind: "file-mention",
			query: "packages/foo",
			start: 6,
			end: 19,
		});
	});

	test("detects active file mention range at cursor", () => {
		expect(detectTrigger("see @packages/foo now", 17)).toEqual({
			kind: "file-mention",
			query: "packages/foo",
			start: 4,
			end: 17,
		});

		expect(detectTrigger("see @packages/foo now", 9)).toEqual({
			kind: "file-mention",
			query: "pack",
			start: 4,
			end: 17,
		});

		expect(detectTrigger("see @packages/foo, now", 17)).toEqual({
			kind: "file-mention",
			query: "packages/foo",
			start: 4,
			end: 17,
		});
	});

	test("replaces only active file mention range", () => {
		expect(
			replaceFileMentionTrigger(
				"see @packages/foo now",
				{
					kind: "file-mention",
					query: "packages/foo",
					start: 4,
					end: 17,
				},
				"packages/foo.ts"
			)
		).toBe("see packages/foo.ts now");

		expect(
			applyFileMentionReplacement(
				"see @packages/foo, now",
				{
					kind: "file-mention",
					query: "pack",
					start: 4,
					end: 17,
				},
				"packages/foo.ts"
			)
		).toEqual({
			cursorOffset: 19,
			text: "see packages/foo.ts, now",
		});
	});
});
