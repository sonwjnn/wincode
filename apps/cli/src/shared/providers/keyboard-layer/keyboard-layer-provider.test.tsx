import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { useState } from "react";
import {
	KeyboardLayerProvider,
	useToggleShortcut,
} from "./keyboard-layer-provider";

function ToggleProbe({ label }: { label: string }) {
	const [expanded, setExpanded] = useState(false);
	useToggleShortcut("ctrl+o", () => setExpanded((value) => !value));
	return <text>{`${label}: ${expanded ? "open" : "closed"}`}</text>;
}
const flushInput = async (): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 20);
	await promise;
};

test("Ctrl+O toggles every registered block handler", async () => {
	const setup = await testRender(
		<KeyboardLayerProvider>
			<box flexDirection="column">
				<ToggleProbe label="first" />
				<ToggleProbe label="second" />
			</box>
		</KeyboardLayerProvider>,
		{ height: 4, width: 40 }
	);

	try {
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("first: closed");
		expect(setup.captureCharFrame()).toContain("second: closed");

		await flushInput();
		setup.mockInput.pressKey("o", { ctrl: true });
		await flushInput();
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("first: open");
		expect(setup.captureCharFrame()).toContain("second: open");

		setup.mockInput.pressKey("o", { ctrl: true });
		await flushInput();
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("first: closed");
		expect(setup.captureCharFrame()).toContain("second: closed");
	} finally {
		setup.renderer.destroy();
	}
});
