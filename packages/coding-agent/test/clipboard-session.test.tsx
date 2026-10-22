import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createRendererSession } from "@/tui/renderer-session";

test("destroying the renderer session disposes the clipboard service", async () => {
	const setup = await createTestRenderer({ height: 5, width: 20 });
	const session = await createRendererSession(async () => setup.renderer);
	const clipboard = session.clipboard as { dispose: () => Promise<void> };
	let disposed = 0;
	const dispose = clipboard.dispose.bind(clipboard);
	clipboard.dispose = async () => {
		disposed += 1;
		await dispose();
	};

	await act(() => session.destroy());

	expect(disposed).toBe(1);
});
