import { expect, test } from "bun:test";
import type { UiHost } from "@wincode/tui";
import { createTestRenderer } from "@wincode/tui/testing";
import { act } from "react";
import { startIndependentPromptFlow } from "../examples/prompt-flow";

test("an independent prompt flow returns a confirmed value and restores its composer", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 12,
		kittyKeyboard: true,
		width: 48,
	});
	let result: string | undefined;
	let host: UiHost | undefined;
	try {
		await act(() => {
			host = startIndependentPromptFlow(
				setup.renderer,
				(value) => (result = value)
			);
		});
		await act(() => setup.flush());
		expect(setup.captureCharFrame()).toContain("What should we call");

		await act(() => setup.mockInput.typeText("north-star"));
		await act(() => setup.mockInput.pressEnter());
		await act(() => setup.flush());
		expect(setup.captureCharFrame()).toContain("Use north-star?");

		await act(() => setup.mockInput.pressArrow("up"));
		await act(() => setup.mockInput.pressEnter());
		await act(() => setup.flush());
		expect(result).toBe("north-star");
		expect(setup.captureCharFrame()).toContain("Confirmed: north-star");

		await act(() => setup.mockInput.typeText("composer-restored"));
		await act(() => setup.flush());
		expect(setup.captureCharFrame()).toContain("Composer: composer-restored");
	} finally {
		if (host !== undefined) {
			await act(() => host?.unmount());
		}
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("an independent prompt cancels on Escape and stays within a narrow terminal", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 10,
		kittyKeyboard: true,
		width: 32,
	});
	let result: string | undefined = "pending";
	let host: UiHost | undefined;
	try {
		await act(() => {
			host = startIndependentPromptFlow(
				setup.renderer,
				(value) => (result = value)
			);
		});
		await act(() => setup.flush());
		const initialFrame = setup.captureCharFrame();
		expect(initialFrame).toContain("What should");
		const lines = initialFrame.split("\n").slice(0, -1);
		expect(lines).toHaveLength(10);
		expect(lines.every((line) => Bun.stringWidth(line) <= 32)).toBe(true);

		await act(() => setup.mockInput.typeText("not-a-composer-value"));
		await act(() => setup.mockInput.pressEscape());
		await act(() => setup.flush());
		expect(result).toBeUndefined();
		expect(setup.captureCharFrame()).toContain("Prompt cancelled.");

		await act(() => setup.mockInput.typeText("restored"));
		await act(() => setup.flush());
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Composer: restored");
		expect(frame).not.toContain("not-a-composer-value");
	} finally {
		if (host !== undefined) {
			await act(() => host?.unmount());
		}
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
