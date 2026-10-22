import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createRendererSession } from "@/tui/renderer-session";
import { createRecordingClipboard } from "./support/clipboard";
import { flushTestRenderer } from "./support/opentui";

test("startup canvas remains text-free and keeps one background while content changes", async () => {
	const setup = await createTestRenderer({ height: 24, width: 80 });
	const session = await createRendererSession(
		async () => setup.renderer,
		() => createRecordingClipboard()
	);
	try {
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame().trim()).toBe("");
		const background = setup.captureSpans().lines[0]?.spans[0]?.bg;
		// ThemedRoot leaves the canvas transparent so the terminal background shows through.
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
