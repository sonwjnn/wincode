import type { TestRendererSetup } from "@opentui/core/testing";
import { act } from "react";

export const flushTestRenderer = async (
	setup: TestRendererSetup,
	passes = 1
): Promise<void> => {
	for (let pass = 0; pass < passes; pass += 1) {
		await act(async () => {
			await Bun.sleep(20);
			await setup.renderOnce();
		});
	}
};
