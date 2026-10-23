import { expect, test } from "bun:test";
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/react";
import { act, useEffect } from "react";
import { CopyOnSelect } from "@/shared/clipboard";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { ThemedRoot } from "@/tui/layouts/themed-root";
import {
	createRecordingClipboard,
	createSelection,
	testRenderWithClipboard,
} from "./support/clipboard";
import { flushTestRenderer as flush } from "./support/opentui";

const renderSelection = async (
	enabled: boolean,
	onKey: () => void = () => undefined,
	layerId?: string
) => {
	const clipboard = createRecordingClipboard();
	const content = (
		<ThemeProvider>
			<ToastProvider>
				<ThemedRoot>
					<text>selected text</text>
					<CopyOnSelect behavior={enabled ? "select" : "manual"} />
					<KeyProbe onKey={onKey} />
				</ThemedRoot>
			</ToastProvider>
		</ThemeProvider>
	);
	const setup = await testRenderWithClipboard(
		layerId ? (
			<KeyboardLayerProvider>
				<LayerProbe id={layerId} />
				{content}
			</KeyboardLayerProvider>
		) : (
			content
		),
		{ height: 10, kittyKeyboard: true, width: 40 },
		clipboard
	);
	let clears = 0;
	setup.renderer.getSelection = () => createSelection("selected text");
	setup.renderer.clearSelection = () => {
		clears += 1;
	};
	await flush(setup, 2);
	return {
		clipboard,
		clears: () => clears,
		setup,
	};
};

function KeyProbe({ onKey }: { onKey: () => void }) {
	useKeyboard(() => {
		onKey();
	});
	return null;
}

function LayerProbe({ id }: { id: string }) {
	const { pop, push } = useKeyboardLayer();

	useEffect(() => {
		push(id, () => true);
		return () => pop(id);
	}, [id, pop, push]);

	return null;
}

const pressCopyShortcut = (
	setup: Awaited<ReturnType<typeof renderSelection>>["setup"]
) => {
	setup.mockInput.pressKey(
		"c",
		process.platform === "darwin" ? { super: true } : { ctrl: true }
	);
};

test("right-click copies a selection in manual mode", async () => {
	const { clipboard, clears, setup } = await renderSelection(false);
	try {
		await act(async () => {
			await setup.mockMouse.click(1, 0, MouseButtons.RIGHT);
			await Bun.sleep(20);
		});
		await flush(setup);

		expect(clipboard.writes).toEqual(["selected text"]);
		expect(clears()).toBe(0);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("right-click does not copy in select mode", async () => {
	const { clipboard, setup } = await renderSelection(true);
	try {
		await act(async () => {
			await setup.mockMouse.click(1, 0, MouseButtons.RIGHT);
			await Bun.sleep(20);
		});
		await flush(setup);

		expect(clipboard.writes).toEqual([]);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("right-click defers to a dialog keyboard layer", async () => {
	const { clipboard, setup } = await renderSelection(
		false,
		() => undefined,
		"dialog"
	);
	try {
		await act(async () => {
			await setup.mockMouse.click(1, 0, MouseButtons.RIGHT);
			await Bun.sleep(20);
		});
		await flush(setup);

		expect(clipboard.writes).toEqual([]);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("the copy shortcut copies a selection in manual mode", async () => {
	const { clipboard, clears, setup } = await renderSelection(false);
	try {
		await act(async () => {
			pressCopyShortcut(setup);
			await Bun.sleep(20);
		});
		await flush(setup);

		expect(clipboard.writes).toEqual(["selected text"]);
		expect(clears()).toBe(0);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("the copy shortcut copies a selected range without clearing it", async () => {
	const { clipboard, clears, setup } = await renderSelection(true);
	try {
		await act(async () => {
			pressCopyShortcut(setup);
			await Bun.sleep(20);
		});
		await flush(setup);

		expect(clipboard.writes).toEqual(["selected text"]);
		expect(clears()).toBe(0);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("Escape clears a selection and typing clears a non-editor selection", async () => {
	const { clears, setup } = await renderSelection(false);
	try {
		await act(async () => {
			setup.mockInput.pressEscape();
			await Bun.sleep(20);
		});
		expect(clears()).toBe(1);

		await act(async () => {
			setup.mockInput.pressKey("a");
			await Bun.sleep(20);
		});
		expect(clears()).toBe(2);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("selection keys run before other global key handlers without swallowing typing", async () => {
	let probeCalls = 0;
	const { setup } = await renderSelection(false, () => {
		probeCalls += 1;
	});
	try {
		await act(async () => {
			pressCopyShortcut(setup);
			await Bun.sleep(20);
		});
		expect(probeCalls).toBe(0);

		await act(async () => {
			setup.mockInput.pressKey("a");
			await Bun.sleep(20);
		});
		expect(probeCalls).toBe(1);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test("selection keys defer to a dialog keyboard layer", async () => {
	const { clipboard, clears, setup } = await renderSelection(
		false,
		() => undefined,
		"dialog"
	);
	try {
		await flush(setup, 2);
		await act(async () => {
			setup.mockInput.pressEscape();
			pressCopyShortcut(setup);
			await Bun.sleep(20);
		});

		expect(clipboard.writes).toEqual([]);
		expect(clears()).toBe(0);
	} finally {
		act(() => setup.renderer.destroy());
	}
});
