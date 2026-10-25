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
