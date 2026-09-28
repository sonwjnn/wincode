import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";

export const flushTestRenderer = async (
	setup: TestRendererSetup
): Promise<void> => {
	await act(async () => {
		await Bun.sleep(20);
		await setup.renderOnce();
	});
};
