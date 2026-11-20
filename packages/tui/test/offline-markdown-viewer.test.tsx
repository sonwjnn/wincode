/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import type { UiHost } from "@wincode/tui";
import { createTestRenderer, MockTreeSitterClient } from "@wincode/tui/testing";
import { act } from "react";
import { startOfflineMarkdownViewer } from "../examples/offline-markdown-viewer";

test("the offline Markdown viewer scrolls, reflows, selects text, and delegates exit", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 8,
		kittyKeyboard: true,
		width: 40,
	});
	let stopCalls = 0;
	let host: UiHost | undefined;

	try {
		await act(() => {
			host = startOfflineMarkdownViewer(
				setup.renderer,
				() => {
					stopCalls += 1;
				},
				new MockTreeSitterClient({ autoResolveTimeout: 0 })
			);
		});
		await setup.flush();
		const initialFrame = setup.captureCharFrame();
		expect(initialFrame).toContain("Offline Markdown viewer");
		expect(initialFrame).toContain("This viewer uses");
		expect(initialFrame).not.toContain("END OF DOCUMENT");

		await act(async () => {
			await setup.mockMouse.drag(1, 3, 35, 5);
			await setup.flush();
		});
		const selectedText = setup.renderer.getSelection()?.getSelectedText() ?? "";
		expect(selectedText).toContain("viewer uses");
		expect(selectedText.length).toBeGreaterThan(30);
		setup.renderer.clearSelection();

		await act(async () => {
			setup.resize(20, 10);
			await setup.flush();
		});
		const resizedFrame = setup.captureCharFrame();
		expect(resizedFrame).toContain("This viewer uses");
		expect(resizedFrame).toContain("\nonly **@wincode/");
		expect(resizedFrame).not.toEqual(initialFrame);

		for (let step = 0; step < 240; step++) {
			await setup.mockMouse.scroll(1, 4, "down");
		}
		await setup.flush();
		const scrolledFrame = setup.captureCharFrame();
		expect(scrolledFrame).toContain("END OF DOCUMENT");
		expect(scrolledFrame).not.toContain("BEGIN");

		await act(() => setup.mockInput.pressEscape());
		await setup.flush();
		expect(stopCalls).toBe(1);
	} finally {
		await act(async () => host?.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
