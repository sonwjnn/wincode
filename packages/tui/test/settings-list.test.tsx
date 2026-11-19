/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import {
	createUiHost,
	SettingsList,
	ThemeProvider,
	type TuiTheme,
} from "@wincode/tui";
import { createTestRenderer } from "@wincode/tui/testing";
import { act } from "react";

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

const clockOptions = [
	{ id: "12-hour", label: "12-hour", value: "12-hour" },
	{ id: "24-hour", label: "24-hour", value: "24-hour" },
] as const;

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

		await act(() => setup.mockInput.pressArrow("down"));
		await setup.flush();
		expect(currentValue).toBe("12-hour");
		expect(changes).toEqual([]);
		expect(setup.captureCharFrame()).toContain("● 12-hour");

		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(currentValue).toBe("24-hour");
		expect(changes).toEqual(["24-hour"]);
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
