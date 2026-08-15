import { describe, expect, test } from "bun:test";
import { keepTailUtf8, truncateUtf8 } from "./output-bounds";

const hasUnpairedSurrogate = (value: string): boolean => {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc_00 || next > 0xdf_ff) {
				return true;
			}
			index += 1;
		} else if (codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff) {
			return true;
		}
	}
	return false;
};

describe("truncateUtf8", () => {
	test("preserves repeated astral characters at truncation boundaries", () => {
		const value = "\u{1ffff}".repeat(4);
		const result = truncateUtf8(value, 9);

		expect(result).toBe("\u{1ffff}".repeat(2));
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(9);
		expect(hasUnpairedSurrogate(result)).toBe(false);
	});

	test("replaces lone high and low surrogates in retained prefix", () => {
		const result = truncateUtf8("a\ud800b\udc00c", 20);

		expect(result).toBe("a\ufffdb\ufffdc");
		expect(hasUnpairedSurrogate(result)).toBe(false);
	});
});

describe("keepTailUtf8", () => {
	test("returns the value unchanged when it fits", () => {
		expect(keepTailUtf8("hello", 1024)).toBe("hello");
	});

	test("keeps the final bytes and never splits a multi-byte character", () => {
		const value = "abc\u{1ffff}\u{1ffff}def";
		const result = keepTailUtf8(value, 7);
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(7);
		expect(result.endsWith("def")).toBe(true);
		expect(hasUnpairedSurrogate(result)).toBe(false);
	});

	test("drops continuation bytes that open the retained tail", () => {
		// 5 astral chars (4 bytes each) kept to 9 bytes: the first retained
		// char is cut mid-sequence and must be dropped entirely.
		const value = "\u{1ffff}".repeat(5);
		const result = keepTailUtf8(value, 9);
		expect(result).toBe("\u{1ffff}".repeat(2));
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(9);
		expect(hasUnpairedSurrogate(result)).toBe(false);
	});

	test("returns an empty string for a non-positive budget", () => {
		expect(keepTailUtf8("abc", 0)).toBe("");
		expect(keepTailUtf8("abc", -1)).toBe("");
	});

	test("keeps ASCII tails byte-exact", () => {
		expect(keepTailUtf8("abcdef", 3)).toBe("def");
	});
});
