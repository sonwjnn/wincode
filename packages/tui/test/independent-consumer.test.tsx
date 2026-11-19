import { expect, test } from "bun:test";
import { createTestRenderer } from "@wincode/tui/testing";
import { act } from "react";
import { startIndependentApp } from "../examples/independent-app";

test("an independent consumer renders shared UI and keeps renderer teardown application-owned", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 16, width: 80 });
	let destroyCalls = 0;
	const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);
	setup.renderer.destroy = () => {
		if (destroyCalls === 0) {
			destroyCalls += 1;
		}
		destroyRenderer();
	};
	let unmount = (): void => undefined;
	await act(() => {
		const host = startIndependentApp(setup.renderer, () => undefined);
		unmount = () => host.unmount();
	});

	try {
		await setup.flush();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Independent OpenTUI + React app");
		expect(frame).toContain("Loading local configuration");
		expect(frame).toContain("Indexing files");
		expect(frame).toContain("Workspace ready");
		expect(frame).toContain("Local operation failed");
		expect(frame).toContain("Offline example notification");

		await act(() => setup.mockInput.pressKey("d"));
		await setup.flush();
		expect(setup.captureCharFrame()).not.toContain(
			"Offline example notification"
		);

		await act(() => unmount());
		expect(destroyCalls).toBe(0);
	} finally {
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
	expect(destroyCalls).toBe(1);
});

test("an independent notes app returns multiline edits, pasted text, and selected replacements to its host", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 12,
		kittyKeyboard: true,
		width: 60,
	});
	let unmount = (): void => undefined;
	await act(() => {
		const host = startIndependentApp(setup.renderer, () => undefined);
		unmount = () => host.unmount();
	});

	try {
		await act(async () => {
			await setup.mockInput.typeText("first");
			await setup.flush();
		});
		await act(async () => {
			setup.mockInput.pressEnter();
			await setup.flush();
		});
		await act(async () => {
			await setup.mockInput.pasteBracketedText("second");
			await setup.flush();
		});
		await act(async () => {
			setup.mockInput.pressArrow("left", { shift: true });
			await setup.flush();
		});
		await act(async () => {
			await setup.mockInput.pasteBracketedText("!");
			await setup.flush();
		});
		await act(async () => setup.flush());

		const frame = await setup.waitForFrame((candidate) => {
			const lines = candidate.split("\n").map((line) => line.trim());
			return lines.includes("Saved note: first") && lines.includes("secon!");
		});
		const lines = frame.split("\n").map((line) => line.trim());
		const savedNoteLine = lines.indexOf("Saved note: first");
		expect(savedNoteLine).toBeGreaterThanOrEqual(0);
		expect(lines[savedNoteLine + 1]).toBe("secon!");
	} finally {
		await act(() => unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});

test("an independent notes app applies its own completion and cancels without changing the draft", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({
		height: 12,
		kittyKeyboard: true,
		width: 60,
	});
	let unmount = (): void => undefined;
	await act(() => {
		const host = startIndependentApp(setup.renderer, () => undefined);
		unmount = () => host.unmount();
	});

	try {
		await act(async () => {
			await setup.mockInput.typeText("Draft note");
		});
		await act(async () => {
			await setup.waitForFrame((frame) =>
				frame.includes("Saved note: Draft note")
			);
		});

		await act(async () => {
			setup.mockInput.pressKey(" ", { ctrl: true });
			await setup.flush();
		});
		await act(async () => {
			await setup.waitForFrame((frame) =>
				frame.includes("Write a meeting recap")
			);
		});
		await act(async () => {
			setup.mockInput.pressArrow("down");
			await setup.flush();
		});
		await act(async () => {
			setup.mockInput.pressKey("\u001b[27u");
			await setup.flush();
		});
		await act(async () => {
			await setup.waitForFrame(
				(frame) =>
					frame.includes("Saved note: Draft note") &&
					!frame.includes("Write a meeting recap")
			);
		});

		await act(async () => {
			setup.mockInput.pressKey(" ", { ctrl: true });
			await setup.flush();
		});
		await act(async () => {
			await setup.waitForFrame((frame) =>
				frame.includes("Update the launch plan")
			);
		});
		await act(async () => {
			setup.mockInput.pressArrow("down");
			await setup.flush();
		});
		await act(async () => {
			setup.mockInput.pressEnter();
			await setup.flush();
		});
		await act(async () => {
			await setup.waitForFrame((frame) =>
				frame.includes("Saved note: Confirm the launch plan")
			);
		});
	} finally {
		await act(() => unmount());
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
