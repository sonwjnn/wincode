import { expect, test } from "bun:test";
import {
	createUiHost,
	LocalStyleProvider,
	NotificationToast,
	StatusFeedback,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";
import { RGBA } from "@wincode/tui/core";
import {
	createTestRenderer,
	type TestRendererSetup,
} from "@wincode/tui/testing";
import { act } from "react";

const infoColor = "#0011aa";
const theme: TuiTheme = {
	colors: {
		error: "#ff0000",
		info: infoColor,
		success: "#00aa00",
		warning: "#aa8800",
		backgroundMenu: "#222222",
	},
};
const localError = "#cc00cc";

const readForeground = (setup: TestRendererSetup, text: string) =>
	setup
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((span) => span.text.includes(text))
		?.fg.toInts();

test("shared feedback shows each operation state with active theme and local overrides", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 80 });
	const host = createUiHost(setup.renderer);
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<box flexDirection="column" gap={1}>
						<StatusFeedback message="Loading repository" status="loading" />
						<StatusFeedback
							message="Indexing files"
							progress={{ current: 2, total: 4 }}
							status="progress"
						/>
						<StatusFeedback message="Operation complete" status="success" />
						<LocalStyleProvider colors={{ error: localError }}>
							<StatusFeedback message="Operation failed" status="error" />
						</LocalStyleProvider>
					</box>
				</ThemeProvider>
			)
		);
		await setup.flush();

		const frame = setup.captureCharFrame();
		expect(frame).toContain("Loading repository");
		expect(frame).toContain("Indexing files");
		expect(frame).toContain("[━━━━────]");
		expect(frame).toContain("Operation complete");
		expect(frame).toContain("Operation failed");
		expect(readForeground(setup, "Loading repository")).toEqual(
			RGBA.fromHex(infoColor).toInts()
		);
		expect(readForeground(setup, "Operation complete")).toEqual(
			RGBA.fromHex(theme.colors.success).toInts()
		);
		expect(readForeground(setup, "Operation failed")).toEqual(
			RGBA.fromHex(localError).toInts()
		);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("notification toast uses the themed variant color", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 6, width: 80 });
	const host = createUiHost(setup.renderer);
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<LocalStyleProvider colors={{ error: localError }}>
						<NotificationToast
							message="The operation could not be completed"
							variant="error"
						/>
					</LocalStyleProvider>
				</ThemeProvider>
			)
		);
		await setup.flush();

		expect(setup.captureCharFrame()).toContain(
			"The operation could not be completed"
		);
		expect(
			readForeground(setup, "The operation could not be completed")
		).toEqual(RGBA.fromHex(localError).toInts());
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
