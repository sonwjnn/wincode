import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { AsciiArt } from "@/modules/sessions/ui/components/ascii-art";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { flushTestRenderer } from "../support/opentui";

const captureArt = async (width: number, height: number): Promise<string> => {
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<AsciiArt />
		</ThemeProvider>,
		{ height, width }
	);

	try {
		await flushTestRenderer(setup);
		return setup.captureCharFrame();
	} finally {
		await act(() => setup.renderer.destroy());
	}
};

const measureArt = (frame: string) => {
	const lines = frame.split("\n").filter((line) => line.trim().length > 0);
	return {
		height: lines.length,
		width: Math.max(0, ...lines.map((line) => Bun.stringWidth(line.trim()))),
	};
};

test("switches the ASCII wordmark to fonts that fit narrower terminals", async () => {
	const full = measureArt(await captureArt(80, 24));
	const medium = measureArt(await captureArt(50, 24));
	const narrow = measureArt(await captureArt(32, 24));
	const short = measureArt(await captureArt(80, 15));

	expect(full).toEqual({ height: 6, width: 62 });
	expect(medium).toEqual({ height: 6, width: 42 });
	expect(narrow).toEqual({ height: 2, width: 28 });
	expect(short).toEqual({ height: 2, width: 28 });
});

test("hides the ASCII wordmark when it cannot fit the terminal", async () => {
	const tooNarrow = measureArt(await captureArt(29, 24));
	const tooShort = measureArt(await captureArt(80, 11));

	expect(tooNarrow).toEqual({ height: 0, width: 0 });
	expect(tooShort).toEqual({ height: 0, width: 0 });
});
