import { describe, expect, test } from "bun:test";
import {
	applyFileMentionReplacement,
	detectFileMentionAtCursor,
	findFileMentionRanges,
	normalizeFileMentionPath,
	replaceFileMentionRange,
} from "./mention-grammar";

describe("mention grammar", () => {
	test("detects file mentions and ignores email and quoted text", () => {
		expect(detectFileMentionAtCursor("@packages/foo", 13)).toEqual({
			end: 13,
			query: "packages/foo",
			start: 0,
		});
		expect(detectFileMentionAtCursor("hello foo@bar.com", 17)).toBeNull();
		expect(detectFileMentionAtCursor("'@packages/foo'", 14)).toBeNull();
		expect(detectFileMentionAtCursor('"@packages/foo"', 14)).toBeNull();
		expect(detectFileMentionAtCursor("`@packages/foo`", 14)).toBeNull();
		expect(detectFileMentionAtCursor("don't @packages/foo", 19)).toEqual({
			end: 19,
			query: "packages/foo",
			start: 6,
		});
	});

	test("finds normalized render and resolve ranges", () => {
		expect(
			findFileMentionRanges(
				'see @apps/cli/ and ignore "@secret.txt" plus foo@bar.com'
			)
		).toEqual([{ end: 14, query: "apps/cli/", start: 4 }]);
		expect(normalizeFileMentionPath("apps/cli///")).toBe("apps/cli");
		expect(normalizeFileMentionPath("///")).toBeNull();
	});

	test("replaces only active file mention range", () => {
		expect(
			replaceFileMentionRange(
				"see @packages/foo now",
				{
					end: 17,
					query: "packages/foo",
					start: 4,
				},
				"packages/foo.ts"
			)
		).toBe("see packages/foo.ts now");

		expect(
			applyFileMentionReplacement(
				"see @packages/foo, now",
				{
					end: 17,
					query: "pack",
					start: 4,
				},
				"@packages/foo.ts"
			)
		).toEqual({
			cursorOffset: 20,
			text: "see @packages/foo.ts, now",
		});
	});

	test("adds or reuses one cursor space after replacement", () => {
		expect(
			applyFileMentionReplacement(
				"see @packages/foo",
				{
					end: 17,
					query: "packages/foo",
					start: 4,
				},
				"@packages/foo.ts"
			)
		).toEqual({
			cursorOffset: 21,
			text: "see @packages/foo.ts ",
		});

		expect(
			applyFileMentionReplacement(
				"see @packages/foo now",
				{
					end: 17,
					query: "packages/foo",
					start: 4,
				},
				"@packages/foo.ts"
			)
		).toEqual({
			cursorOffset: 21,
			text: "see @packages/foo.ts now",
		});
	});
});
