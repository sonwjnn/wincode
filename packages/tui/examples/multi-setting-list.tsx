/** @jsxImportSource @wincode/tui */

import {
	SearchablePicker,
	SettingsList,
	type SettingsListOption,
	type SettingsListRow,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";
import { TextAttributes } from "@wincode/tui/core";
import { useState } from "react";

const theme: TuiTheme = {
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

const clockChoices = [
	{ id: "12-hour", label: "12-hour", value: "12-hour" },
	{ id: "24-hour", label: "24-hour", value: "24-hour" },
] as const satisfies readonly [
	SettingsListOption<string>,
	...SettingsListOption<string>[],
];

const themeChoices = [
	{ id: "dark", label: "Dark", value: "dark" },
	{ id: "light", label: "Light", value: "light" },
] as const satisfies readonly [
	SettingsListOption<string>,
	...SettingsListOption<string>[],
];

function getValueLabel(value: string): string {
	switch (value) {
		case "12-hour":
		case "24-hour":
			return value;
		case "dark":
			return "Dark";
		case "light":
			return "Light";
		default:
			return value;
	}
}

/** A consumer-owned settings screen combining fast cycling and a nested chooser. */
export function MultiSettingListExample() {
	const [clock, setClock] = useState("12-hour");
	const [colorTheme, setColorTheme] = useState("dark");
	const rows: readonly SettingsListRow<string>[] = [
		{
			choices: clockChoices,
			currentValue: clock,
			id: "clock",
			label: "Clock format",
		},
		{
			currentValue: colorTheme,
			id: "theme",
			label: "Color theme",
			renderSubmenu: ({ currentValue, onSelect }) => (
				<SearchablePicker
					getKey={(option) => option.id}
					getSearchText={(option) => option.label}
					isItemActive={(option) => option.value === currentValue}
					items={themeChoices}
					onSelect={(option) => onSelect(option.value)}
					placeholder="Choose a theme"
					renderItem={(option, { isActive, isSelected }) => (
						<text
							attributes={isSelected ? TextAttributes.INVERSE : undefined}
							selectable={false}
						>
							{`${isActive ? "●" : " "} ${option.label}`}
						</text>
					)}
				/>
			),
		},
	];

	return (
		<ThemeProvider theme={theme}>
			<SettingsList
				getValueLabel={getValueLabel}
				onChange={(rowId, value) => {
					if (rowId === "clock") {
						setClock(value);
					} else {
						setColorTheme(value);
					}
				}}
				rows={rows}
			/>
		</ThemeProvider>
	);
}
