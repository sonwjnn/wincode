/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import {
	createUiHost,
	SettingsList,
	type SettingsListRow,
	type SettingsListSubmenuProps,
	ThemeProvider,
	type TuiTheme,
	useKeyboard,
} from "@wincode/tui";
import { createTestRenderer } from "@wincode/tui/testing";
import { act, useState } from "react";

const theme: TuiTheme = {
	colors: {
		error: "#ff7b72",
		info: "#58a6ff",
		selection: "#33435b",
		success: "#3fb950",
		text: "#f0f0f0",
		textMuted: "#9ca3af",
		warning: "#d29922",
	},
};

function ConfirmSubmenu({
	currentValue,
	onSelect,
}: SettingsListSubmenuProps<string>) {
	useKeyboard((key) => {
		if (key.name === "enter" || key.name === "return") {
			key.preventDefault();
			key.stopPropagation();
			onSelect("dark");
		}
	});
	return <text>{`Submenu current value: ${currentValue}`}</text>;
}

const clockOptions = [
	{ id: "12-hour", label: "12-hour", value: "12-hour" },
	{ id: "24-hour", label: "24-hour", value: "24-hour" },
] as const;

test("settings rows cycle controlled values with wraparound without changing props", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 8, width: 32 });
	const host = createUiHost(setup.renderer);
	const changes: Array<readonly [string, string]> = [];
	let setCurrentValue: (value: string) => void = () => undefined;
	function ControlledSettings() {
		const [currentValue, updateCurrentValue] = useState("b");
		setCurrentValue = updateCurrentValue;
		return (
			<ThemeProvider theme={theme}>
				<SettingsList
					getValueLabel={(value: string) => value.toUpperCase()}
					onChange={(rowId, value: string) => changes.push([rowId, value])}
					rows={[
						{
							choices: [
								{ id: "a", label: "Alpha", value: "a" },
								{ id: "b", label: "Beta", value: "b" },
							],
							currentValue,
							id: "mode",
							label: "Mode",
						},
					]}
				/>
			</ThemeProvider>
		);
	}

	try {
		await act(() => host.render(<ControlledSettings />));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Mode: B");

		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(changes).toEqual([["mode", "a"]]);
		expect(setup.captureCharFrame()).toContain("Mode: B");

		await act(() => setCurrentValue("a"));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Mode: A");

		await act(async () => {
			setup.mockInput.pressKey(" ");
			await setup.flush();
		});
		expect(changes).toEqual([
			["mode", "a"],
			["mode", "b"],
		]);

		await act(() => setCurrentValue("unavailable"));
		await setup.flush();
		await act(async () => {
			setup.mockInput.pressEnter();
			await setup.flush();
		});
		expect(changes).toEqual([
			["mode", "a"],
			["mode", "b"],
			["mode", "a"],
		]);
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("submenu cancellation returns to the focused row and confirmation reports once", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 10,
		kittyKeyboard: true,
		width: 40,
	});
	const host = createUiHost(setup.renderer);
	const changes: Array<readonly [string, string]> = [];
	const rows: readonly SettingsListRow<string>[] = [
		{
			choices: [
				{ id: "12", label: "12-hour", value: "12" },
				{ id: "24", label: "24-hour", value: "24" },
			],
			currentValue: "12",
			id: "clock",
			label: "Clock",
		},
		{
			currentValue: "light",
			id: "theme",
			label: "Theme",
			renderSubmenu: (props) => <ConfirmSubmenu {...props} />,
		},
	];

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SettingsList
						onChange={(id, value) => changes.push([id, value])}
						rows={rows}
					/>
				</ThemeProvider>
			)
		);
		await setup.flush();

		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Submenu current value: light");

		await act(() => setup.mockInput.pressEscape());
		await setup.flush();
		expect(changes).toEqual([]);
		expect(setup.captureCharFrame()).toContain("› Theme: light");

		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(changes).toEqual([["theme", "dark"]]);
		expect(setup.captureCharFrame()).toContain("› Theme: light");
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("the focused setting remains visible after a narrow terminal resize", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 10, width: 40 });
	const host = createUiHost(setup.renderer);
	const rows: readonly SettingsListRow<string>[] = Array.from(
		{ length: 6 },
		(_, index) => ({
			choices: [{ id: "on", label: "On", value: "on" }],
			currentValue: "on",
			id: `setting-${index}`,
			label: `Setting ${index}`,
		})
	);

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SettingsList
						maxVisibleItems={2}
						onChange={() => undefined}
						rows={rows}
					/>
				</ThemeProvider>
			)
		);
		await setup.flush();

		for (let index = 0; index < 5; index += 1) {
			await act(async () => {
				setup.mockInput.pressArrow("down");
				await setup.flush();
			});
		}
		await act(async () => {
			setup.resize(18, 5);
			await setup.flush();
		});
		expect(setup.captureCharFrame()).toContain("› Setting 5: On");
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("settings list keeps the current value until Enter confirms another option", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const host = createUiHost(setup.renderer);
	let currentValue = "12-hour";
	const changes: string[] = [];

	try {
		await act(() =>
			host.render(
				<ThemeProvider theme={theme}>
					<SettingsList
						currentValue={currentValue}
						onSelect={(value) => {
							currentValue = value;
							changes.push(value);
						}}
						options={clockOptions}
						placeholder="Clock format"
					/>
				</ThemeProvider>
			)
		);
		await setup.flush();

		expect(setup.captureCharFrame()).toContain("● 12-hour");
		expect(setup.captureCharFrame()).toContain("24-hour");

		await act(async () => {
			setup.mockInput.pressArrow("down");
			await setup.flush();
		});
		expect(currentValue).toBe("12-hour");
		expect(changes).toEqual([]);
		expect(setup.captureCharFrame()).toContain("● 12-hour");

		await act(async () => {
			setup.mockInput.pressEnter();
			await setup.flush();
		});
		expect(currentValue).toBe("24-hour");
		expect(changes).toEqual(["24-hour"]);
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
