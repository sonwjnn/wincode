import { expect, test } from "bun:test";
import {
	createUiHost,
	InlineNotice,
	LocalStyleProvider,
	ThemeProvider,
	type TuiTheme,
	useTheme,
} from "@wincode/tui";
import { RGBA } from "@wincode/tui/core";
import {
	createTestRenderer,
	type TestRendererSetup,
} from "@wincode/tui/testing";
import { act } from "react";

const createTheme = (info: string): TuiTheme => ({
	colors: {
		error: "#ff7b72",
		info,
		success: "#3fb950",
		warning: "#d29922",
	},
});
const firstTheme = createTheme("#112233");
const nextTheme = createTheme("#445566");
const localInfoColor = "#aabbcc";

function ThemeColorProbe({ children }: { children: string }) {
	const { colors } = useTheme();
	return <text fg={colors.info}>{children}</text>;
}

const readForeground = (frame: TestRendererSetup, text: string) =>
	frame
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((span) => span.text.includes(text))
		?.fg.toInts();

test("a theme prop update reactively changes shared component colors", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 5, width: 40 });
	const host = createUiHost(setup.renderer);
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={firstTheme}>
					<InlineNotice>Theme follows its provider</InlineNotice>
				</ThemeProvider>
			)
		);
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Theme follows its provider");
		expect(readForeground(setup, "Theme follows its provider")).toEqual(
			RGBA.fromHex(firstTheme.colors.info).toInts()
		);

		await act(() =>
			host.render(
				<ThemeProvider theme={nextTheme}>
					<InlineNotice>Theme follows its provider</InlineNotice>
				</ThemeProvider>
			)
		);
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Theme follows its provider");
		expect(readForeground(setup, "Theme follows its provider")).toEqual(
			RGBA.fromHex(nextTheme.colors.info).toInts()
		);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("local style colors override only descendants without changing the app theme", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 7, width: 40 });
	const host = createUiHost(setup.renderer);
	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={firstTheme}>
					<InlineNotice>Global notice</InlineNotice>
					<ThemeColorProbe>App theme probe</ThemeColorProbe>
					<LocalStyleProvider colors={{ info: localInfoColor }}>
						<InlineNotice>Local notice</InlineNotice>
						<ThemeColorProbe>Local theme probe</ThemeColorProbe>
					</LocalStyleProvider>
				</ThemeProvider>
			)
		);
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Local notice");

		expect(readForeground(setup, "Global notice")).toEqual(
			RGBA.fromHex(firstTheme.colors.info).toInts()
		);
		expect(readForeground(setup, "Local notice")).toEqual(
			RGBA.fromHex(localInfoColor).toInts()
		);
		expect(readForeground(setup, "App theme probe")).toEqual(
			RGBA.fromHex(firstTheme.colors.info).toInts()
		);
		expect(readForeground(setup, "Local theme probe")).toEqual(
			RGBA.fromHex(localInfoColor).toInts()
		);
	} finally {
		await act(() => host.unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
