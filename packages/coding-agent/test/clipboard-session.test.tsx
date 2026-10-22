import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createRendererSession } from "@/tui/renderer-session";

test("destroying the renderer session disposes the clipboard before renderer teardown", async () => {
	const setup = await createTestRenderer({ height: 5, width: 20 });
	const events: string[] = [];
	const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);
	setup.renderer.destroy = () => {
		events.push("renderer");
		destroyRenderer();
	};
	const session = await createRendererSession(async () => setup.renderer);
	const clipboard = session.clipboard as { dispose: () => Promise<void> };
	const dispose = clipboard.dispose.bind(clipboard);
	clipboard.dispose = async () => {
		events.push("clipboard");
		await dispose();
	};

	await act(() => session.destroy());

	expect(events).toEqual(["clipboard", "renderer"]);
});
