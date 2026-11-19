import { expect, test } from "bun:test";
import { createTestRenderer } from "@wincode/tui/testing";
import { act } from "react";
import { startIndependentApp } from "../examples/independent-app";

test("an independent consumer renders shared UI and keeps renderer teardown application-owned", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 8, width: 60 });
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
		expect(setup.captureCharFrame()).toContain(
			"Independent OpenTUI + React app"
		);
		expect(setup.captureCharFrame()).toContain(
			"Shared notice from @wincode/tui"
		);

		await act(() => unmount());
		expect(destroyCalls).toBe(0);
	} finally {
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
	expect(destroyCalls).toBe(1);
});
