import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ThemedRoot } from "@/tui/layouts/themed-root";
import { flushTestRenderer } from "../support/opentui";

test("the empty app surface stays transparent with opaque themes", async () => {
	for (const themeName of ["one-dark", "opencode"]) {
		const setup = await testRender(
			<ThemeProvider themeName={themeName}>
				<ThemedRoot>{null}</ThemedRoot>
			</ThemeProvider>,
			{ height: 3, width: 8 }
		);
		try {
			await flushTestRenderer(setup, 1);
			const backgrounds = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans.map((span) => span.bg.a));

			expect(backgrounds.length).toBeGreaterThan(0);
			expect(backgrounds.every((alpha) => alpha === 0)).toBe(true);
		} finally {
			await act(() => setup.renderer.destroy());
		}
	}
});
