/** @jsxImportSource @wincode/tui */

import {
	createUiHost,
	SearchablePicker,
	ThemeProvider,
	type TuiTheme,
	useKeyboard,
	useTheme,
} from "@wincode/tui";
import { type CliRenderer, createCliRenderer } from "@wincode/tui/core";
import { useCallback } from "react";

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

const TIME_ZONES = [
	{ id: "UTC", label: "UTC" },
	{ id: "America/Los_Angeles", label: "Los Angeles" },
	{ id: "America/New_York", label: "New York" },
	{ id: "America/Sao_Paulo", label: "São Paulo" },
	{ id: "Europe/London", label: "London" },
	{ id: "Europe/Paris", label: "Paris" },
	{ id: "Africa/Nairobi", label: "Nairobi" },
	{ id: "Asia/Kolkata", label: "Kolkata" },
	{ id: "Asia/Tokyo", label: "Tokyo" },
	{ id: "Australia/Sydney", label: "Sydney" },
] as const;

type TimeZoneOption = (typeof TIME_ZONES)[number];
type TimeZonePickerProps = Readonly<{
	initialTimeZone: string;
	onFinish: (timeZone: string | undefined) => void;
}>;

function TimeZonePicker({ initialTimeZone, onFinish }: TimeZonePickerProps) {
	const { colors } = useTheme();
	const textColor = typeof colors.text === "string" ? colors.text : colors.info;
	const mutedTextColor =
		typeof colors.textMuted === "string" ? colors.textMuted : colors.info;
	const handleCancel = useCallback(() => onFinish(undefined), [onFinish]);

	useKeyboard((key) => {
		if (key.name === "escape") {
			key.preventDefault();
			handleCancel();
		}
	});

	return (
		<box flexDirection="column" gap={1} padding={1}>
			<text>Offline time-zone picker</text>
			<text fg={mutedTextColor}>{`Current time zone: ${initialTimeZone}`}</text>
			<SearchablePicker<TimeZoneOption>
				emptyText="No matching time zones"
				footer={
					<text fg={mutedTextColor}>
						↑↓ navigate · enter select · esc cancel
					</text>
				}
				getKey={(timeZone) => timeZone.id}
				getSearchText={(timeZone) => [timeZone.label, timeZone.id]}
				isItemActive={(timeZone) => timeZone.id === initialTimeZone}
				items={TIME_ZONES}
				onSelect={(timeZone) => onFinish(timeZone.id)}
				placeholder="Search time zones"
				renderItem={(timeZone, { isActive, isSelected }) => (
					<box flexDirection="row" gap={1} overflow="hidden">
						<text fg={isSelected ? textColor : mutedTextColor}>
							{isActive ? "●" : " "}
						</text>
						<text fg={isSelected ? textColor : mutedTextColor}>
							{timeZone.label}
						</text>
					</box>
				)}
			/>
		</box>
	);
}

export type RunTimeZonePickerOptions = Readonly<{
	createRenderer?: () => CliRenderer | Promise<CliRenderer>;
	initialTimeZone: string;
	onConfirm?: (timeZone: string) => void;
}>;

async function createAppRenderer(): Promise<CliRenderer> {
	return createCliRenderer({ exitOnCtrlC: false });
}

/** Runs the independent picker and owns the renderer it uses through teardown. */
export async function runTimeZonePicker({
	createRenderer = createAppRenderer,
	initialTimeZone,
	onConfirm,
}: RunTimeZonePickerOptions): Promise<string | undefined> {
	const rendererResult = createRenderer();
	const renderer =
		rendererResult instanceof Promise ? await rendererResult : rendererResult;
	const host = createUiHost(renderer);
	const completion = Promise.withResolvers<string | undefined>();

	try {
		host.render(
			<ThemeProvider theme={APP_THEME}>
				<TimeZonePicker
					initialTimeZone={initialTimeZone}
					onFinish={completion.resolve}
				/>
			</ThemeProvider>
		);
		const selectedTimeZone = await completion.promise;
		if (selectedTimeZone !== undefined) {
			onConfirm?.(selectedTimeZone);
		}
		return selectedTimeZone;
	} finally {
		host.unmount();
		renderer.destroy();
	}
}

async function runExample(): Promise<void> {
	let currentTimeZone =
		Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const result = await runTimeZonePicker({
		initialTimeZone: currentTimeZone,
		onConfirm: (timeZone) => {
			currentTimeZone = timeZone;
		},
	});
	console.log(
		result === undefined
			? `Cancelled; time zone remains ${currentTimeZone}`
			: `Selected time zone: ${currentTimeZone}`
	);
}

if (import.meta.main) {
	await runExample();
}
