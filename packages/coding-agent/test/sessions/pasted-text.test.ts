import { describe, expect, test } from "bun:test";
import {
	expandPastedText,
	expandPastedTextInRange,
	normalizePastedText,
	summarizePastedText,
} from "@/modules/sessions/pasted-text";

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
		expect(expandPastedText(a.token, [a])).toBe(a.text);
	});
	test("expands only the tracked occurrence when a literal marker comes first", () => {
		const token = "[Pasted ~3 lines]";
		const text = `${token} is literal; actual ${token}`;
		const start = text.lastIndexOf(token);

		expect(
			expandPastedText(text, [{ start, text: "one\ntwo\nthree", token }])
		).toBe(`${token} is literal; actual one\ntwo\nthree`);
	});
	test("expands only the marker covered by the selected range", () => {
		const token = "[Pasted ~3 lines]";
		const first = { end: token.length, start: 0, text: "a\nb\nc" };
		const secondStart = token.length + 1;
		const second = {
			end: secondStart + token.length,
			start: secondStart,
			text: "x\ny\nz",
		};
		const selection = { end: second.end, start: second.start - 1 };
		const selectedText = `${token} ${token}`.slice(
			selection.start,
			selection.end
		);

		expect(selectedText).toBe(` ${token}`);
		expect(
			expandPastedTextInRange(selectedText, selection, [first, second])
		).toBe(` ${second.text}`);
	});
	test("drops removed marker", () => {
		const a = { token: "[Pasted ~3 lines]", text: "one\ntwo\nthree" };
		expect(expandPastedText("kept", [a])).toBe("kept");
	});
});
