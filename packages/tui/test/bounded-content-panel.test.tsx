/** @jsxImportSource @wincode/tui */

import { expect, test } from "bun:test";
import { BoundedContentPanel } from "@wincode/tui";
import { testRender } from "@wincode/tui/testing";
import { act } from "react";

const lines = [
	"BEGIN wide content wraps into rows at narrow widths",
	...Array.from({ length: 22 }, (_, index) => `Content row ${index + 1}`),
	"END",
];

function LongContentView() {
	return (
		<scrollbox height="100%" width="100%">
			<BoundedContentPanel>
				{lines.map((line) => (
					<text key={line}>{line}</text>
				))}
			</BoundedContentPanel>
		</scrollbox>
	);
}

test("a bounded content panel stays readable, scrollable, resizable, and selectable", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const setup = await testRender(<LongContentView />, { height: 6, width: 32 });

	try {
		await setup.flush();
		const initialFrame = setup.captureCharFrame();
		expect(initialFrame).toContain("BEGIN wide content wraps");
		expect(initialFrame).not.toContain("END");

		setup.resize(18, 6);
		await setup.flush();
		const resizedFrame = setup.captureCharFrame();
		expect(resizedFrame).toContain("BEGIN");
		expect(resizedFrame).toContain("\nwraps into");
		expect(resizedFrame).not.toEqual(initialFrame);

		for (let step = 0; step < lines.length * 2; step++) {
			await setup.mockMouse.scroll(1, 2, "down");
		}
		await setup.flush();
		const scrolledFrame = setup.captureCharFrame();
		expect(scrolledFrame).toContain("END");
		expect(scrolledFrame).not.toContain("BEGIN");

		await setup.mockMouse.drag(1, 1, 15, 1);
		await setup.flush();
		expect(setup.renderer.getSelection()?.getSelectedText()).toContain(
			"Content row"
		);
	} finally {
		await act(async () => setup.dispose());
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
	}
});
