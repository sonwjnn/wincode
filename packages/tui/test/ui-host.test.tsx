import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createUiHost } from "@wincode/tui";
import { act } from "react";

test("an independent app renders through a UI host without surrendering renderer teardown", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await createTestRenderer({ height: 4, width: 40 });
	let destroyCalls = 0;
	const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);
	setup.renderer.destroy = () => {
		destroyCalls += 1;
		destroyRenderer();
	};

	const host = createUiHost(setup.renderer);
	try {
		await act(() => host.render(<text>Independent application</text>));
		await setup.waitForFrame((frame) =>
			frame.includes("Independent application")
		);

		await act(() => host.unmount());
		expect(destroyCalls).toBe(0);
	} finally {
		await setup.dispose();
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
	expect(destroyCalls).toBe(1);
});
