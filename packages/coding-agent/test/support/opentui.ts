import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";

export const isOpenTuiOutputBusy = (error: unknown): boolean =>
	error instanceof Error && error.message.includes("acquire_buffer_lease");

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
