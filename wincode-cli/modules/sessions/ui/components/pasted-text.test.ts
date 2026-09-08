import { describe, expect, test } from "bun:test";
import {
	expandPastedText,
	normalizePastedText,
	summarizePastedText,
} from "./pasted-text";

describe("pasted text", () => {
	test("normalizes and applies thresholds", () => {
		expect(normalizePastedText("a\r\nb\rc")).toBe("a\nb\nc");
		expect(summarizePastedText("a\nb")).toBeUndefined();
		expect(summarizePastedText("a\nb\nc")?.token).toBe("[Pasted ~3 lines]");
		expect(summarizePastedText("x".repeat(151))?.token).toBe(
			"[Pasted ~1 lines]"
		);
	});
	test("expands repeated markers and wide text", () => {
		const a = { token: "[Pasted ~3 lines]", text: "猫\n犬\n鳥" };
		expect(expandPastedText(`前${a.token}中${a.token}後`, [a, a])).toBe(
			"前猫\n犬\n鳥中猫\n犬\n鳥後"
		);
	});
	test("drops removed marker", () => {
		const a = { token: "[Pasted ~3 lines]", text: "one\ntwo\nthree" };
		expect(expandPastedText("kept", [a])).toBe("kept");
	});
});
