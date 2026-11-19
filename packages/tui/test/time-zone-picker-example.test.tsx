/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import {
	createTestRenderer,
	type TestRendererSetup,
} from "@wincode/tui/testing";
import { act } from "react";
import { runTimeZonePicker } from "../examples/time-zone-picker";

const initialTimeZone = "America/New_York";

function trackRendererTeardown(setup: TestRendererSetup) {
	let destroyCalls = 0;
	const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);
	setup.renderer.destroy = () => {
		if (destroyCalls === 0) {
			destroyCalls += 1;
			destroyRenderer();
		}
	};
	return () => destroyCalls;
}

test("the offline time-zone app confirms a choice and destroys its renderer", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const destroyCalls = trackRendererTeardown(setup);
	let currentTimeZone = initialTimeZone;
	let run: Promise<string | undefined> | undefined;

	try {
		await act(() => {
			run = runTimeZonePicker({
				createRenderer: () => setup.renderer,
				initialTimeZone,
				onConfirm: (timeZone) => {
					currentTimeZone = timeZone;
				},
			});
		});
		await setup.waitForFrame((frame) =>
			frame.includes("Current time zone: America/New_York")
		);
		await setup.flush();
		await setup.waitForFrame((frame) => frame.includes("● New York"));
		expect(setup.captureCharFrame()).toContain(
			"Current time zone: America/New_York"
		);
		expect(setup.captureCharFrame()).toContain("● New York");

		await act(async () => setup.mockInput.typeText("tokyo"));
		await setup.flush();
		expect(setup.captureCharFrame()).toContain("Tokyo");
		let result: string | undefined;
		await act(async () => {
			setup.mockInput.pressEnter();
			result = await run;
		});
		expect(result).toBe("Asia/Tokyo");
		expect(currentTimeZone).toBe("Asia/Tokyo");
		expect(destroyCalls()).toBe(1);
	} finally {
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("a small terminal keeps the active time zone and keyboard cues in view", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 8, width: 48 });
	const destroyCalls = trackRendererTeardown(setup);
	let run: Promise<string | undefined> | undefined;

	try {
		await act(() => {
			run = runTimeZonePicker({
				createRenderer: () => setup.renderer,
				initialTimeZone,
			});
		});
		await setup.flush();
		await setup.waitForFrame((frame) => frame.includes("● New York"));
		const frame = setup.captureCharFrame();
		expect(frame).toContain("● New York");
		expect(frame).toContain("esc cancel");

		await act(async () => {
			setup.mockInput.pressEscape();
			await run;
		});
		expect(destroyCalls()).toBe(1);
	} finally {
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("cancelling the offline time-zone app preserves the prior choice and tears down", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 12, width: 48 });
	const destroyCalls = trackRendererTeardown(setup);
	let currentTimeZone = initialTimeZone;
	let run: Promise<string | undefined> | undefined;

	try {
		await act(() => {
			run = runTimeZonePicker({
				createRenderer: () => setup.renderer,
				initialTimeZone,
				onConfirm: (timeZone) => {
					currentTimeZone = timeZone;
				},
			});
		});
		await setup.waitForFrame((frame) =>
			frame.includes("Current time zone: America/New_York")
		);
		expect(setup.captureCharFrame()).toContain(
			"Current time zone: America/New_York"
		);
		let result: string | undefined;
		await act(async () => {
			setup.mockInput.pressEscape();
			result = await run;
		});
		expect(result).toBeUndefined();
		expect(currentTimeZone).toBe(initialTimeZone);
		expect(destroyCalls()).toBe(1);
	} finally {
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
