import { expect, test } from "bun:test";
import type { InputRenderable } from "@wincode/tui/core";
import { testRender } from "@wincode/tui/testing";
import { act, useEffect, useRef, useState } from "react";
import { ThemeDialogContent } from "@/modules/prompt-settings/ui/theme-dialog";
import {
	DialogProvider,
	useDialog,
} from "@/shared/providers/dialog/dialog-provider";
import {
	KeyboardLayerProvider,
	useKeyboardLayer,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import {
	ThemeProvider,
	useTheme,
} from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME, THEMES } from "@/shared/providers/theme/themes";
import { flushTestRenderer } from "../support/opentui";

function CurrentThemeLabel() {
	const { currentTheme } = useTheme();
	return <text>{`Current theme: ${currentTheme.name}`}</text>;
}

function ThemeDialogHarness() {
	const { open } = useDialog();
	const { push } = useKeyboardLayer();
	const [hostValue, setHostValue] = useState("");
	const hostInputRef = useRef<InputRenderable>(null);

	useEffect(() => {
		push("interactive-host");
		open({
			children: <ThemeDialogContent />,
			restoreFocus: true,
			title: "Select Theme",
		});
	}, [open, push]);

	return (
		<box flexDirection="column">
			<input
				focused
				onContentChange={() => setHostValue(hostInputRef.current?.value ?? "")}
				placeholder="Host input"
				ref={hostInputRef}
			/>
			<text>{`Host input: ${hostValue}`}</text>
			<CurrentThemeLabel />
		</box>
	);
}

async function renderThemeDialog() {
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<KeyboardLayerProvider>
				<DialogProvider>
					<ThemeDialogHarness />
				</DialogProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>,
		{ height: 18, width: 54 }
	);
	await flushTestRenderer(setup, 2);
	return setup;
}

test("theme search previews fuzzy matches and Escape restores theme and host focus", async () => {
	const initialTheme = DEFAULT_THEME;
	const previewTheme = THEMES.find(({ name }) => name === "opencode");
	if (previewTheme === undefined) {
		throw new Error("The opencode theme is unavailable.");
	}
	const setup = await renderThemeDialog();

	try {
		expect(setup.captureCharFrame()).toContain("Search themes");

		await act(async () => setup.mockInput.typeText("open"));
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain("Current theme: opencode");
		expect(setup.captureCharFrame()).toContain("●");
		expect(setup.captureCharFrame()).toContain("opencode");

		await act(() => setup.mockInput.pressEscape());
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain(
			`Current theme: ${initialTheme.name}`
		);
		expect(setup.captureCharFrame()).not.toContain("Search themes");

		await act(async () => setup.mockInput.typeText("host"));
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain("Host input: host");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});

test("confirming a preview keeps it and returns focus to the host", async () => {
	const previewTheme = THEMES.find(({ name }) => name === "opencode");
	if (previewTheme === undefined) {
		throw new Error("The opencode theme is unavailable.");
	}
	const setup = await renderThemeDialog();

	try {
		await act(async () => setup.mockInput.typeText("open"));
		await flushTestRenderer(setup, 2);
		await act(() => setup.mockInput.pressEnter());
		await flushTestRenderer(setup, 2);

		expect(setup.captureCharFrame()).toContain("Current theme: opencode");
		expect(setup.captureCharFrame()).not.toContain("Search themes");

		await act(async () => setup.mockInput.typeText("host"));
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain("Host input: host");
	} finally {
		await act(() => setup.renderer.destroy());
	}
});
