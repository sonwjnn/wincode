import { describe, expect, test } from "bun:test";
import type { SelectionBehavior } from "@opentui/core";
import { ClipboardTooLargeError, handleSelection } from "@/shared/clipboard";
import { createRecordingClipboard } from "./support/clipboard";

const selection = (
	text: string,
	extra: { isStart?: boolean; behavior?: SelectionBehavior } = {}
) => ({
	getSelectedText: () => text,
	isStart: extra.isStart ?? false,
	behavior: extra.behavior ?? "word",
});

describe("handleSelection", () => {
	test("does not copy or toast while copy-on-select is disabled", async () => {
		const toasts: unknown[] = [];
		const clipboard = createRecordingClipboard();

		await handleSelection(selection("hello"), {
			clipboard,
			enabled: false,
			show: (toast) => toasts.push(toast),
		});

		expect(clipboard.writes).toEqual([]);
		expect(toasts).toHaveLength(0);
	});

	test("does not copy the one-cell selection produced by a plain click", async () => {
		const toasts: unknown[] = [];
		const clipboard = createRecordingClipboard();

		await handleSelection(selection("x", { behavior: "cell", isStart: true }), {
			clipboard,
			show: (toast) => toasts.push(toast),
		});

		expect(clipboard.writes).toEqual([]);
		expect(toasts).toHaveLength(0);
	});

	test("copies a double-click word selection even though the pointer never dragged", async () => {
		const clipboard = createRecordingClipboard();

		await handleSelection(
			selection("word", { behavior: "word", isStart: true }),
			{
				clipboard,
				show: () => undefined,
			}
		);

		expect(clipboard.writes).toEqual(["word"]);
	});

	test("ignores an empty selection", async () => {
		const clipboard = createRecordingClipboard();

		await handleSelection(selection(""), {
			clipboard,
			show: () => undefined,
		});

		expect(clipboard.writes).toEqual([]);
	});

	test("toasts success with the compact width after a copy", async () => {
		const toasts: { message: string; variant?: string; width?: number }[] = [];

		await handleSelection(selection("hello"), {
			clipboard: createRecordingClipboard(),
			show: (toast) => toasts.push(toast),
		});

		expect(toasts).toEqual([
			{ message: "Copied to clipboard", variant: "success", width: 30 },
		]);
	});

	test("reports a rejected write without claiming the selection was copied", async () => {
		const toasts: { message: string; variant?: string }[] = [];

		await handleSelection(selection("hello"), {
			clipboard: createRecordingClipboard(async () => {
				throw new Error("host failed");
			}),
			show: (toast) => toasts.push(toast),
		});

		expect(toasts).toEqual([
			{ message: "Failed to copy selection.", variant: "error" },
		]);
	});

	test("reports an oversized selection with the size-specific message", async () => {
		const toasts: { message: string; variant?: string }[] = [];

		await handleSelection(selection("hello"), {
			clipboard: createRecordingClipboard(async () => {
				throw new ClipboardTooLargeError();
			}),
			show: (toast) => toasts.push(toast),
		});

		expect(toasts).toEqual([
			{ message: "Selection is too large to copy.", variant: "error" },
		]);
	});
});
