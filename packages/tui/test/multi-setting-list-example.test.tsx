/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import { createUiHost } from "@wincode/tui";
import { createTestRenderer } from "@wincode/tui/testing";
import { act } from "react";
import { MultiSettingListExample } from "../examples/multi-setting-list";

test("independent consumer combines cycling with an app-owned submenu", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 10, width: 44 });
	const host = createUiHost(setup.renderer);

	try {
		await act(() => host.render(<MultiSettingListExample />));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Clock format: 12-hour");

		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Clock format: 24-hour");

		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Choose a theme");

		await act(() => setup.mockInput.pressArrow("down"));
		await act(() => setup.mockInput.pressEnter());
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Color theme: Light");
	} finally {
		await act(() => host.unmount());
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
