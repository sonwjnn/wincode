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

	test("does not copy selections that never dragged", async () => {
		const toasts: unknown[] = [];
		const clipboard = createRecordingClipboard();

		for (const behavior of ["cell", "word", "line"] as const) {
			await handleSelection(
				createSelection(behavior, { behavior, isStart: true }),
				{
					clipboard,
					show: (toast) => toasts.push(toast),
				}
			);
		}

		expect(clipboard.writes).toEqual([]);
		expect(toasts).toHaveLength(0);
	});

	test("copies the focused renderable's clipboard text when it is selected", async () => {
		const clipboard = createRecordingClipboard();
		const focusedRenderable = {
			id: "composer",
			getClipboardText: (text: string) =>
				text.replace("[Pasted ~3 lines]", "one\ntwo\nthree"),
		};

		await handleSelection(
			createSelection("[Pasted ~3 lines]", {
				selectedRenderables: [focusedRenderable],
			}),
			{
				clipboard,
				focusedRenderable,
				show: () => undefined,
			}
		);

		expect(clipboard.writes).toEqual(["one\ntwo\nthree"]);
	});

	test("keeps the raw selection when the focused renderable has no clipboard transform", async () => {
		const clipboard = createRecordingClipboard();
		const focusedRenderable = { id: "composer" };

		await handleSelection(
			createSelection("raw", { selectedRenderables: [focusedRenderable] }),
			{
				clipboard,
				focusedRenderable,
				show: () => undefined,
			}
		);

		expect(clipboard.writes).toEqual(["raw"]);
	});

	test("keeps the raw selection when the focused renderable is outside it", async () => {
		const clipboard = createRecordingClipboard();
		const focusedRenderable = {
			id: "composer",
			getClipboardText: () => "transformed",
		};

		await handleSelection(createSelection("raw"), {
			clipboard,
			focusedRenderable,
			show: () => undefined,
		});

		expect(clipboard.writes).toEqual(["raw"]);
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
