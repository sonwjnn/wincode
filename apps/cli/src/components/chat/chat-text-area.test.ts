import { describe, expect, test } from "bun:test";
import { submitChatTextAreaValue } from "./chat-text-area";

describe("submitChatTextAreaValue", () => {
	test("submits trimmed text and clears textarea buffer", () => {
		const submitted: string[] = [];
		let clearCount = 0;

		submitChatTextAreaValue({
			disabled: false,
			onSubmit: (value) => submitted.push(value),
			textArea: {
				clear: () => {
					clearCount += 1;
				},
				plainText: "  hello  ",
			},
		});

		expect(submitted).toEqual(["hello"]);
		expect(clearCount).toBe(1);
	});

	test("does not clear when value is empty", () => {
		const submitted: string[] = [];
		let clearCount = 0;

		submitChatTextAreaValue({
			disabled: false,
			onSubmit: (value) => submitted.push(value),
			textArea: {
				clear: () => {
					clearCount += 1;
				},
				plainText: "   ",
			},
		});

		expect(submitted).toEqual([]);
		expect(clearCount).toBe(0);
	});
});
