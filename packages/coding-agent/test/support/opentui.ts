import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";

export const isOpenTuiOutputBusy = (error: unknown): boolean =>
	error instanceof Error &&
	error.message.includes("acquire_buffer_lease") &&
	error.message.includes("OutputBusy");

export const captureTestFrame = (
	setup: TestRendererSetup
): string | undefined => {
	try {
		return setup.captureCharFrame();
	} catch (error) {
		if (isOpenTuiOutputBusy(error)) {
			return;
		}
		throw error;
	}
};

/** Native output may acquire a lease after visual-idle resolves; retry only that transient state. */
export const waitForTestFrame = async (
	setup: TestRendererSetup
): Promise<string> => {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const frame = captureTestFrame(setup);
		if (frame !== undefined) {
			return frame;
		}
		await Bun.sleep(10);
	}
	throw new Error(
		"OpenTUI output buffer remained busy while capturing a test frame"
	);
};

export const requireTestFrame = (setup: TestRendererSetup): string => {
	const frame = captureTestFrame(setup);
	if (frame === undefined) {
		throw new Error("OpenTUI output buffer busy");
	}
	return frame;
};

export const frameIncludes = (
	setup: TestRendererSetup,
	text: string
): boolean => captureTestFrame(setup)?.includes(text) ?? false;

export const flushTestRenderer = async (
	setup: TestRendererSetup,
	passes = 1
): Promise<void> => {
	for (let pass = 0; pass < passes; pass += 1) {
		await act(async () => {
			await Bun.sleep(20);
			await setup.renderOnce();
			await setup.waitForVisualIdle();
		});
	}
};

/**
 * Renders until the frame stops changing, so work whose commit is asynchronous
 * lands before an assertion reads it. Two passes minimum: the first gives an
 * asynchronous commit a window to land, the second sees whether it did. A
 * command slower than that needs a wait of its own, which is what the
 * assertions using it rely on.
 */
export const flushTestRendererUntilStable = async (
	setup: TestRendererSetup,
	maxAttempts = 50
): Promise<void> => {
	await setup.waitForVisualIdle();
	let previous = captureTestFrame(setup) ?? "";
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		await Bun.sleep(20);
		await setup.renderOnce();
		await setup.waitForVisualIdle();
		const frame = captureTestFrame(setup) ?? "";
		if (attempt >= 1 && frame === previous) {
			return;
		}
		previous = frame;
	}
};
