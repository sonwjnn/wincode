import { describe, expect, test } from "bun:test";
import { truncateUtf8 } from "./output-bounds";

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
