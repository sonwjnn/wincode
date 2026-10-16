import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createRendererSession } from "@/tui/renderer-session";
import { flushTestRenderer } from "./support/opentui";

test("startup canvas remains opaque and text-free while content changes", async () => {
	const setup = await createTestRenderer({ height: 24, width: 80 });
	const session = await createRendererSession(async () => setup.renderer);
	try {
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame().trim()).toBe("");
		const background = setup.captureSpans().lines[0]?.spans[0]?.bg;
		expect(background?.a).toBe(1);

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
