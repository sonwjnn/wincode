import { expect, test } from "bun:test";
import { InlineNotice, type InlineNoticeVariant } from "@wincode/tui";
import { RGBA } from "@wincode/tui/core";
import { testRender } from "@wincode/tui/testing";
import { act } from "react";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { flushTestRenderer } from "../support/opentui";

const renderNotice = async (variant: InlineNoticeVariant, text: string) => {
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<InlineNotice variant={variant}>{text}</InlineNotice>
		</ThemeProvider>,
		{ height: 6, width: 80 }
	);
	await flushTestRenderer(setup, 2);
	return setup;
};

test("inline notices color each variant from the theme", async () => {
	for (const variant of ["warning", "error", "info", "success"] as const) {
		const text = `${variant} notice`;
		const setup = await renderNotice(variant, text);
		try {
			const span = setup
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((candidate) => candidate.text.includes(text));
			expect(span).toBeDefined();
			expect(span?.fg.toInts()).toEqual(
				RGBA.fromHex(DEFAULT_THEME.colors[variant]).toInts()
			);
		} finally {
			await act(() => setup.renderer.destroy());
		}
	}
});
