import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runChatCommand } from "../../hooks/use-chat-commands";
import {
	CHAT_TEXT_AREA_MAX_HEIGHT,
	CHAT_TEXT_AREA_MIN_HEIGHT,
	getInputHeight,
	hasInputContent,
	isCtrlC,
} from "../../hooks/use-input-keyboard";
import { submitChatTextAreaValue } from "./chat-text-area";

describe("submitChatTextAreaValue", () => {
	test("submits trimmed text and clears textarea buffer", () => {
		const submitted: string[] = [];
		let clearCount = 0;

		const result = submitChatTextAreaValue({
			disabled: false,
			onSubmit: (value) => submitted.push(value),
			textArea: {
				clear: () => {
					clearCount += 1;
				},
				plainText: "  hello  ",
			},
		});

		expect(result).toBe("submitted");
		expect(submitted).toEqual(["hello"]);
		expect(clearCount).toBe(1);
	});

	test("does not clear when value is empty", () => {
		const submitted: string[] = [];
		let clearCount = 0;

		const result = submitChatTextAreaValue({
			disabled: false,
			onSubmit: (value) => submitted.push(value),
			textArea: {
				clear: () => {
					clearCount += 1;
				},
				plainText: "   ",
			},
		});

		expect(result).toBe("empty");
		expect(submitted).toEqual([]);
		expect(clearCount).toBe(0);
	});

	test("runs exact commands instead of submitting messages", () => {
		const submitted: string[] = [];
		const commands: string[] = [];
		let clearCount = 0;

		const result = submitChatTextAreaValue({
			disabled: false,
			onCommand: (value) => {
				commands.push(value);
				return value === "/exit";
			},
			onSubmit: (value) => submitted.push(value),
			textArea: {
				clear: () => {
					clearCount += 1;
				},
				plainText: "/exit",
			},
		});

		expect(result).toBe("command");
		expect(commands).toEqual(["/exit"]);
		expect(submitted).toEqual([]);
		expect(clearCount).toBe(1);
	});

	test("submits command-like text with space, arguments, or quotes", () => {
		const submitted: string[] = [];
		const commandLikeValues = ["/exit ", "/exit now", '"/exit"', " /exit"];

		for (const plainText of commandLikeValues) {
			submitChatTextAreaValue({
				disabled: false,
				onCommand: (value) => value === "/exit",
				onSubmit: (value) => submitted.push(value),
				textArea: {
					clear: () => undefined,
					plainText,
				},
			});
		}

		expect(submitted).toEqual(["/exit", "/exit now", '"/exit"', "/exit"]);
	});

	test("does not run commands while disabled", () => {
		const submitted: string[] = [];
		const commands: string[] = [];
		let clearCount = 0;

		const result = submitChatTextAreaValue({
			disabled: true,
			onCommand: (value) => {
				commands.push(value);
				return true;
			},
			onSubmit: (value) => submitted.push(value),
			textArea: {
				clear: () => {
					clearCount += 1;
				},
				plainText: "/exit",
			},
		});

		expect(result).toBe("disabled");
		expect(commands).toEqual([]);
		expect(submitted).toEqual([]);
		expect(clearCount).toBe(0);
	});

	test("runs registered command actions with chat command context", () => {
		const actions: string[] = [];
		const context = {
			exit: () => actions.push("exit"),
			newSession: () => actions.push("new"),
		};

		expect(runChatCommand("/exit", context)).toBe(true);
		expect(runChatCommand("/new", context)).toBe(true);
		expect(runChatCommand("/new ", context)).toBe(false);
		expect(actions).toEqual(["exit", "new"]);
	});

	test("detects input content without trimming spaces", () => {
		expect(hasInputContent("")).toBe(false);
		expect(hasInputContent("   ")).toBe(true);
		expect(hasInputContent("hello")).toBe(true);
	});

	test("calculates input height from newline count with max clamp", () => {
		expect(getInputHeight("")).toBe(CHAT_TEXT_AREA_MIN_HEIGHT);
		expect(getInputHeight("one")).toBe(1);
		expect(getInputHeight("one\ntwo\nthree")).toBe(3);
		expect(getInputHeight("1\n2\n3\n4\n5\n6\n7")).toBe(
			CHAT_TEXT_AREA_MAX_HEIGHT
		);
	});

	test("detects ctrl c shortcut", () => {
		expect(
			isCtrlC({
				ctrl: true,
				name: "c",
				preventDefault: () => undefined,
			})
		).toBe(true);
		expect(
			isCtrlC({
				ctrl: false,
				name: "c",
				preventDefault: () => undefined,
			})
		).toBe(false);
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
