/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import {
	createUiHost,
	DialogFrame,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";
import { createTestRenderer } from "@wincode/tui/testing";
import { act } from "react";

const theme: TuiTheme = {
	colors: {
		backgroundElement: "#161b22",
		error: "#ff7b72",
		info: "#58a6ff",
		success: "#3fb950",
		warning: "#d29922",
	},
};

test("a dialog frame clamps its width and reflows when the terminal shrinks", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 10, width: 40 });
	const host = createUiHost(setup.renderer);
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<box height="100%" width="100%">
						<DialogFrame
							backgroundColor="#161b22"
							maxHeight={8}
							padding={0}
							width={80}
						>
							<text>Bounded dialog</text>
						</DialogFrame>
					</box>
				</ThemeProvider>
			)
		);
		await act(() => setup.flush());
		const initialFrame = setup.captureCharFrame();
		const initialLines = initialFrame.split("\n");
		const initialDialogLine = initialLines.find((line) =>
			line.includes("Bounded dialog")
		);
		expect(initialDialogLine?.indexOf("Bounded dialog")).toBe(1);
		expect(initialLines.indexOf(initialDialogLine ?? "")).toBe(5);
		expect(
			initialFrame
				.split("\n")
				.slice(0, -1)
				.every((line) => Bun.stringWidth(line) <= 40)
		).toBe(true);

		await act(() => setup.resize(24, 7));
		await act(() => setup.flush());
		const resizedFrame = setup.captureCharFrame();
		const resizedLines = resizedFrame.split("\n");
		const resizedDialogLine = resizedLines.find((line) =>
			line.includes("Bounded dialog")
		);
		expect(resizedDialogLine?.indexOf("Bounded dialog")).toBe(1);
		expect(resizedLines.indexOf(resizedDialogLine ?? "")).toBe(3);
		expect(
			resizedFrame
				.split("\n")
				.slice(0, -1)
				.every((line) => Bun.stringWidth(line) <= 24)
		).toBe(true);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("a dialog frame clips unscrollable content at its configured height", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 10, width: 40 });
	const host = createUiHost(setup.renderer);
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<box height="100%" width="100%">
						<DialogFrame
							backgroundColor="#161b22"
							maxHeight={4}
							padding={0}
							width={20}
						>
							<box flexDirection="column">
								{Array.from(
									{ length: 12 },
									(_, index) => `Frame row ${index + 1}`
								).map((row) => (
									<text key={row}>{row}</text>
								))}
							</box>
						</DialogFrame>
					</box>
				</ThemeProvider>
			)
		);
		await act(() => setup.flush());
		const frame = setup.captureCharFrame();
		const visibleRows = Array.from(
			{ length: 12 },
			(_, index) => `Frame row ${index + 1}`
		).filter((row) => frame.includes(row));
		expect(visibleRows).toEqual([
			"Frame row 1",
			"Frame row 2",
			"Frame row 3",
			"Frame row 4",
		]);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("only an active dialog frame routes backdrop clicks to its host", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 10, width: 40 });
	const host = createUiHost(setup.renderer);
	let dismissals = 0;
	const render = (active: boolean) =>
		host.render(
			<ThemeProvider theme={theme}>
				<box height="100%" width="100%">
					<DialogFrame
						active={active}
						backgroundColor="#161b22"
						onBackdropClick={() => dismissals++}
						padding={0}
						width={16}
					>
						<text>Dialog content</text>
					</DialogFrame>
				</box>
			</ThemeProvider>
		);
	try {
		await act(() => render(false));
		await act(() => setup.flush());
		await act(() => setup.mockMouse.click(0, 0));
		expect(dismissals).toBe(0);

		await act(() => render(true));
		await act(() => setup.flush());
		await act(() => setup.mockMouse.click(0, 0));
		expect(dismissals).toBe(1);
		await act(() => setup.mockMouse.click(13, 4));
		expect(dismissals).toBe(1);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
