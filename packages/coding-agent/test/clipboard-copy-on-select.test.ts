import { describe, expect, test } from "bun:test";
import { ClipboardTooLargeError, handleSelection } from "@/shared/clipboard";
import { createRecordingClipboard, createSelection } from "./support/clipboard";

describe("handleSelection", () => {
	test("does not copy or toast while copy-on-select is disabled", async () => {
		const toasts: unknown[] = [];
		const clipboard = createRecordingClipboard();

		await handleSelection(createSelection("hello"), {
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

		await handleSelection(
			createSelection("x", { behavior: "cell", isStart: true }),
			{
				clipboard,
				show: (toast) => toasts.push(toast),
			}
		);

		expect(clipboard.writes).toEqual([]);
		expect(toasts).toHaveLength(0);
	});

	test("copies a double-click word selection even though the pointer never dragged", async () => {
		const clipboard = createRecordingClipboard();

		await handleSelection(
			createSelection("word", { behavior: "word", isStart: true }),
			{
				clipboard,
				show: () => undefined,
			}
		);

		expect(clipboard.writes).toEqual(["word"]);
	});

	test("ignores an empty selection", async () => {
		const clipboard = createRecordingClipboard();

		await handleSelection(createSelection(""), {
			clipboard,
			show: () => undefined,
		});

		expect(clipboard.writes).toEqual([]);
	});

	test("toasts success with the compact width after a copy", async () => {
		const toasts: { message: string; variant?: string; width?: number }[] = [];

		await handleSelection(createSelection("hello"), {
			clipboard: createRecordingClipboard(),
			show: (toast) => toasts.push(toast),
		});

		expect(toasts).toEqual([
			{ message: "Copied to clipboard", variant: "success", width: 30 },
		]);
	});

	test("stays silent when the write resolves without copying", async () => {
		const toasts: unknown[] = [];

		await handleSelection(createSelection("hello"), {
			clipboard: { write: async () => "empty" },
			show: (toast) => toasts.push(toast),
		});

		expect(toasts).toEqual([]);
	});

	test("reports a rejected write without claiming the selection was copied", async () => {
		const toasts: { message: string; variant?: string }[] = [];

		await handleSelection(createSelection("hello"), {
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

		await handleSelection(createSelection("hello"), {
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
