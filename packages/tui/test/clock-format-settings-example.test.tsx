/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import {
	createTestRenderer,
	type TestRendererSetup,
} from "@wincode/tui/testing";
import { act } from "react";
import {
	type ClockFormat,
	runClockFormatSettings,
} from "../examples/clock-format-settings";

const initialFormat: ClockFormat = "12-hour";

const startSettings = async (
	setup: TestRendererSetup,
	onConfirm: (format: ClockFormat) => void
): Promise<{ run: Promise<ClockFormat | undefined> }> => {
	const result = Promise.withResolvers<ClockFormat | undefined>();
	await act(() => {
		void runClockFormatSettings({
			createRenderer: () => setup.renderer,
			initialFormat,
			onConfirm,
		}).then(result.resolve, result.reject);
	});
	await setup.waitForFrame((frame) =>
		frame.includes("Current clock format: 12-hour")
	);
	return { run: result.promise };
};

test("independent settings app commits the selected clock format", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	let currentFormat: ClockFormat = initialFormat;

	try {
		const { run } = await startSettings(setup, (format) => {
			currentFormat = format;
		});
		expect(setup.captureCharFrame()).toContain("● 12-hour clock");

		await act(() => setup.mockInput.pressArrow("down"));
		expect(currentFormat).toBe(initialFormat);

		let result: ClockFormat | undefined;
		await act(async () => {
			setup.mockInput.pressEnter();
			result = await run;
		});
		expect(result).toBe("24-hour");
		expect(String(currentFormat)).toBe("24-hour");
	} finally {
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("cancelling the independent settings app preserves its current value", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	let currentFormat: ClockFormat = initialFormat;

	try {
		const { run } = await startSettings(setup, (format) => {
			currentFormat = format;
		});
		await act(() => setup.mockInput.pressArrow("down"));
		expect(currentFormat).toBe(initialFormat);

		let result: ClockFormat | undefined;
		await act(async () => {
			setup.mockInput.pressEscape();
			result = await run;
		});
		expect(result).toBeUndefined();
		expect(currentFormat).toBe(initialFormat);
	} finally {
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
