import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createRendererSession } from "@/tui/renderer-session";
import { flushTestRenderer } from "./support/opentui";

test("startup canvas stays text-free over a transparent background while content changes", async () => {
	const setup = await createTestRenderer({ height: 24, width: 80 });
	const session = await createRendererSession(async () => setup.renderer);
	try {
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame().trim()).toBe("");
		const background = setup.captureSpans().lines[0]?.spans[0]?.bg;
		// ca8aa5a2 removed ThemedRoot's backgroundColor and RootLayout paints none,
		// so the canvas is transparent and the terminal background shows through.
		// The old opaque assertion described the pre-ca8aa5a2 root; 0.5.14 already
		// reported a transparent buffer, so this locks the current contract.
		expect(background).toEqual(RGBA.fromValues(0, 0, 0, 0));

		await act(() => session.render(<text>Ready</text>));
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame()).toContain("Ready");
		expect(setup.captureSpans().lines[0]?.spans[0]?.bg).toEqual(background);

		await act(() => session.renderStartupBackground());
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame().trim()).toBe("");
		expect(setup.captureSpans().lines[0]?.spans[0]?.bg).toEqual(background);
	} finally {
		await act(() => session.destroy());
	}
});
