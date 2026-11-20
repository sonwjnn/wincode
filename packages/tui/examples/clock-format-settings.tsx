/** @jsxImportSource @wincode/tui */

import {
	createUiHost,
	SettingsList,
	type SettingsListOption,
	ThemeProvider,
	type TuiTheme,
	useKeyboard,
} from "@wincode/tui";
import { type CliRenderer, createCliRenderer } from "@wincode/tui/core";
import { useCallback } from "react";

export type ClockFormat = "12-hour" | "24-hour";

const APP_THEME: TuiTheme = {
	colors: {
		backgroundElement: "#17191d",
		error: "#ff7b72",
		info: "#58a6ff",
		selection: "#33435b",
		success: "#3fb950",
		text: "#f0f0f0",
		textMuted: "#9ca3af",
		warning: "#d29922",
	},
};

const CLOCK_FORMATS: readonly SettingsListOption<ClockFormat>[] = [
	{
		description: "Use AM/PM markers",
		id: "12-hour",
		label: "12-hour clock",
		value: "12-hour",
	},
	{
		description: "Use 00–23 hour values",
		id: "24-hour",
		label: "24-hour clock",
		value: "24-hour",
	},
];

function ClockFormatSettings({
	currentFormat,
	onFinish,
}: Readonly<{
	currentFormat: ClockFormat;
	onFinish: (format: ClockFormat | undefined) => void;
}>) {
	const handleCancel = useCallback(() => onFinish(undefined), [onFinish]);

	useKeyboard((key) => {
		if (key.name !== "escape") {
			return;
		}
		key.preventDefault();
		key.stopPropagation();
		handleCancel();
	});

	return (
		<box flexDirection="column" gap={1}>
			<text>{`Current clock format: ${currentFormat}`}</text>
			<SettingsList
				currentValue={currentFormat}
				onSelect={onFinish}
				options={CLOCK_FORMATS}
				placeholder="Choose a clock format"
			/>
			<text>↑↓ navigate · enter apply · esc cancel</text>
		</box>
	);
}

export type RunClockFormatSettingsOptions = Readonly<{
	createRenderer?: () => CliRenderer | Promise<CliRenderer>;
	initialFormat: ClockFormat;
	onConfirm?: (format: ClockFormat) => void;
}>;

async function createAppRenderer(): Promise<CliRenderer> {
	return createCliRenderer({ exitOnCtrlC: false });
}

/** Runs the independent settings app and owns the renderer through teardown. */
export async function runClockFormatSettings({
	createRenderer = createAppRenderer,
	initialFormat,
	onConfirm,
}: RunClockFormatSettingsOptions): Promise<ClockFormat | undefined> {
	const rendererResult = createRenderer();
	const renderer =
		rendererResult instanceof Promise ? await rendererResult : rendererResult;
	const host = createUiHost(renderer);
	const completion = Promise.withResolvers<ClockFormat | undefined>();

	try {
		host.render(
			<ThemeProvider theme={APP_THEME}>
				<ClockFormatSettings
					currentFormat={initialFormat}
					onFinish={completion.resolve}
				/>
			</ThemeProvider>
		);
		const selectedFormat = await completion.promise;
		if (selectedFormat !== undefined) {
			onConfirm?.(selectedFormat);
		}
		return selectedFormat;
	} finally {
		host.unmount();
		renderer.destroy();
	}
}

async function runExample(): Promise<void> {
	let currentFormat: ClockFormat = "12-hour";
	const result = await runClockFormatSettings({
		initialFormat: currentFormat,
		onConfirm: (format) => {
			currentFormat = format;
		},
	});
	console.log(
		result === undefined
			? `Cancelled; clock format remains ${currentFormat}.`
			: `Clock format is now ${currentFormat}.`
	);
}

if (import.meta.main) {
	await runExample();
}
