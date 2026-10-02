import { describe, expect, test } from "bun:test";
import {
	applyTextEdit,
	commandInsertionSeparator,
	type TrackedCommandSelection,
} from "@/modules/sessions/hooks/input-controller/selections";

const review = (start: number): TrackedCommandSelection => ({
	end: start + "/skill:review".length,
	kind: "skill",
	marker: "/skill:review",
	name: "review",
	start,
});

describe("applyTextEdit", () => {
	test("shifts a marker when prose before it changes", () => {
		const previous = "please /skill:review";
		const next = "hey please /skill:review";

		expect(applyTextEdit([review(7)], previous, next)).toEqual([review(11)]);
	});

	test("shifts a marker when prose after it changes", () => {
		const previous = "/skill:review now";
		const next = "/skill:review now please";

		expect(applyTextEdit([review(0)], previous, next)).toEqual([review(0)]);
	});

	test("drops the intent when the marker itself is edited", () => {
		const previous = "please /skill:review";
		const next = "please /skill:reviw";

		expect(applyTextEdit([review(7)], previous, next)).toEqual([]);
	});

	test("drops the intent when the marker is deleted", () => {
		const previous = "please /skill:review now";
		const next = "please  now";

		expect(applyTextEdit([review(7)], previous, next)).toEqual([]);
	});

	test("drops the intent when the text is replaced wholesale", () => {
		expect(applyTextEdit([review(0)], "/skill:review", "plain prompt")).toEqual(
			[]
		);
	});

	test("keeps ranges when the text did not change", () => {
		expect(
			applyTextEdit([review(0)], "/skill:review", "/skill:review")
		).toEqual([review(0)]);
	});
});

describe("commandInsertionSeparator", () => {
	test("adds a trailing space at the end of the prompt", () => {
		expect(commandInsertionSeparator("please /mdl", 11, false)).toBe(" ");
	});

	test("keeps the existing whitespace after a mid-prose trigger", () => {
		expect(commandInsertionSeparator("please /mdl review", 11, false)).toBe("");
	});

	test("adds no separator when the namespace chooser reopens", () => {
		expect(commandInsertionSeparator("/skill", 6, true)).toBe("");
	});
});
