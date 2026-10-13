import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { StartupBackground } from "@/tui/layouts/startup-background";
import { flushTestRenderer } from "./support/opentui";

test("startup canvas stays text-free and fills the screen with the active theme background", async () => {
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<StartupBackground />
		</ThemeProvider>,
		{ height: 24, width: 80 }
	);
	try {
		await flushTestRenderer(setup, 2);
		expect(setup.captureCharFrame().trim()).toBe("");
		const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
		expect(spans.length).toBeGreaterThan(0);
		expect(
			spans.every((span) =>
				span.bg.equals(RGBA.fromHex(DEFAULT_THEME.colors.background))
			)
		).toBe(true);
	} finally {
		await setup.renderer.destroy();
	}
});
