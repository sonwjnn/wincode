import { describe, expect, test } from "bun:test";
import type { Selection } from "@opentui/core";
import {
	handleSelectionKey,
	isCopyShortcut,
	type SelectionKeyEvent,
	type SelectionKeyHost,
} from "@/shared/clipboard";
import { createRecordingClipboard, createSelection } from "./support/clipboard";

const createKey = (
	overrides: Partial<SelectionKeyEvent> = {}
): SelectionKeyEvent & { prevented: boolean; stopped: boolean } => {
	const key = {
		ctrl: false,
		name: "a",
		super: false,
		preventDefault: () => {
			key.prevented = true;
		},
		stopPropagation: () => {
			key.stopped = true;
		},
		prevented: false,
		stopped: false,
		...overrides,
	};
	return key;
};

const createCopyKey = (
	overrides: Partial<SelectionKeyEvent> = {}
): SelectionKeyEvent & { prevented: boolean; stopped: boolean } => {
	const modifiers =
		process.platform === "darwin" ? { super: true } : { ctrl: true };
	return createKey({ name: "c", ...modifiers, ...overrides });
};

const createHost = (
	selection: Selection | null,
	overrides: Partial<SelectionKeyHost> = {}
): { host: SelectionKeyHost; clears: () => number } => {
	let clears = 0;
	return {
		host: {
			clearSelection: () => {
				clears += 1;
			},
			getSelection: () => selection,
			...overrides,
		},
		clears: () => clears,
	};
};

const flushWrite = async (): Promise<void> => {
	await Bun.sleep(1);
};

describe("handleSelectionKey", () => {
	test("the copy shortcut copies a selection and keeps it visible", async () => {
		const clipboard = createRecordingClipboard();
		const key = createCopyKey();
		const { host, clears } = createHost(createSelection("hello"));

		handleSelectionKey(key, host, {
			clipboard,
			show: () => undefined,
		});
		await flushWrite();

		expect(clipboard.writes).toEqual(["hello"]);
		expect(clears()).toBe(0);
		expect(key.prevented).toBe(true);
		expect(key.stopped).toBe(true);
	});

	test("the copy shortcut copies a double-click word selection", async () => {
		const clipboard = createRecordingClipboard();
		const key = createCopyKey();
		const { host, clears } = createHost(
			createSelection("hello", { behavior: "word", isStart: true })
		);

		handleSelectionKey(key, host, {
			clipboard,
			show: () => undefined,
		});
		await flushWrite();

		expect(clipboard.writes).toEqual(["hello"]);
		expect(clears()).toBe(0);
		expect(key.prevented).toBe(true);
	});

	test("the copy shortcut absorbs an empty selection without clearing it", async () => {
		const clipboard = createRecordingClipboard();
		const key = createCopyKey();
		const { host, clears } = createHost(createSelection(""));

		handleSelectionKey(key, host, {
			clipboard,
			show: () => undefined,
		});
		await flushWrite();

		expect(clipboard.writes).toEqual([]);
		expect(clears()).toBe(0);
		expect(key.prevented).toBe(true);
		expect(key.stopped).toBe(true);
	});

	test("the copy shortcut absorbs a plain cell click without copying it", async () => {
		const clipboard = createRecordingClipboard();
		const key = createCopyKey();
		const { host, clears } = createHost(
			createSelection("hello", { behavior: "cell", isStart: true })
		);

		handleSelectionKey(key, host, {
			clipboard,
			show: () => undefined,
		});
		await flushWrite();

		expect(clipboard.writes).toEqual([]);
		expect(clears()).toBe(0);
		expect(key.prevented).toBe(true);
	});

	test("the copy shortcut copies while an editor owns its local selection", async () => {
		const clipboard = createRecordingClipboard();
		const editor = { hasSelection: () => true };
		const key = createCopyKey();
		const { host, clears } = createHost(
			createSelection("hello", { selectedRenderables: [editor] }),
			{ currentFocusedEditor: editor }
		);

		handleSelectionKey(key, host, {
			clipboard,
			show: () => undefined,
		});
		await flushWrite();

		expect(clipboard.writes).toEqual(["hello"]);
		expect(clears()).toBe(0);
		expect(key.prevented).toBe(true);
	});

	test("Cmd+C is the macOS copy shortcut and Ctrl+C is used elsewhere", () => {
		expect(
			isCopyShortcut(createKey({ name: "c", super: true }), "darwin")
		).toBe(true);
		expect(isCopyShortcut(createKey({ ctrl: true, name: "c" }), "darwin")).toBe(
			false
		);
		expect(isCopyShortcut(createKey({ ctrl: true, name: "c" }), "win32")).toBe(
			true
		);
		expect(isCopyShortcut(createKey({ name: "c", super: true }), "linux")).toBe(
			false
		);
	});

	test("the non-mac copy shortcut accepts Kitty's Latin base-layout code", () => {
		expect(
			isCopyShortcut(
				createKey({ baseCode: 99, ctrl: true, name: "с" }),
				"linux"
			)
		).toBe(true);
	});

	test("Escape clears a dragged selection and consumes the key", () => {
		const key = createKey({ name: "escape" });
		const { host, clears } = createHost(createSelection("hello"));

		handleSelectionKey(key, host, {
			clipboard: createRecordingClipboard(),
			show: () => undefined,
		});

		expect(clears()).toBe(1);
		expect(key.prevented).toBe(true);
		expect(key.stopped).toBe(true);
	});

	test("Escape clears a plain cell click without swallowing Escape", () => {
		const key = createKey({ name: "escape" });
		const { host, clears } = createHost(
			createSelection("hello", { behavior: "cell", isStart: true })
		);

		handleSelectionKey(key, host, {
			clipboard: createRecordingClipboard(),
			show: () => undefined,
		});

		expect(clears()).toBe(1);
		expect(key.prevented).toBe(false);
		expect(key.stopped).toBe(false);
	});

	test("Escape does nothing when there is no selection", () => {
		const key = createKey({ name: "escape" });
		const { host, clears } = createHost(null);

		handleSelectionKey(key, host, {
			clipboard: createRecordingClipboard(),
			show: () => undefined,
		});

		expect(clears()).toBe(0);
		expect(key.prevented).toBe(false);
	});

	test("typing clears a selection outside an editor", () => {
		const key = createKey({ name: "a" });
		const { host, clears } = createHost(createSelection("hello"));

		handleSelectionKey(key, host, {
			clipboard: createRecordingClipboard(),
			show: () => undefined,
		});

		expect(clears()).toBe(1);
	});

	test("typing leaves an editor-owned selection to the editor", () => {
		const editor = { hasSelection: () => true };
		const key = createKey({ name: "a" });
		const { host, clears } = createHost(
			createSelection("hello", { selectedRenderables: [editor] }),
			{ currentFocusedEditor: editor }
		);

		handleSelectionKey(key, host, {
			clipboard: createRecordingClipboard(),
			show: () => undefined,
		});

		expect(clears()).toBe(0);
	});
});
