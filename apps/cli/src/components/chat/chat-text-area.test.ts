import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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

	test("does not bind shift tab to model cycling", async () => {
		const [textAreaSource, promptConfigSource] = await Promise.all([
			readFile(new URL("./chat-text-area.tsx", import.meta.url), "utf8"),
			readFile(
				new URL("../../providers/prompt-config/index.tsx", import.meta.url),
				"utf8"
			),
		]);

		expect(textAreaSource).not.toContain("cycleModel");
		expect(textAreaSource).not.toContain("key.shift");
		expect(promptConfigSource).not.toContain("cycleModel");
	});
});
