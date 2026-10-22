import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createRendererSession } from "@/tui/renderer-session";
import { createRecordingClipboard } from "./support/clipboard";

test("renderer session disposes the clipboard service so native clipboard workers do not outlive the TUI", async () => {
	const setup = await createTestRenderer({ height: 5, width: 20 });
	const clipboard = createRecordingClipboard();
	const session = await createRendererSession(
		async () => setup.renderer,
		() => clipboard
	);

	expect(clipboard.disposed).toBe(0);
	await act(() => session.destroy());
	expect(clipboard.disposed).toBe(1);
});
