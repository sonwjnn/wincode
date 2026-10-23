import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { openExternalLink } from "@/shared/links/open-external-link";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { LinkOpenErrorToast } from "@/tui/layouts/link-open-error-toast";
import { flushTestRenderer } from "./support/opentui";

test("a failed link open is visible in the TUI", async () => {
	const setup = await testRender(
		<ThemeProvider>
			<ToastProvider>
				<LinkOpenErrorToast />
			</ToastProvider>
		</ThemeProvider>,
		{ height: 8, width: 60 }
	);
	try {
		await flushTestRenderer(setup, 2);
		await act(async () => {
			await openExternalLink("https://example.com", () =>
				Promise.reject(new Error("no browser"))
			);
		});
		await flushTestRenderer(setup, 2);

		expect(setup.captureCharFrame()).toContain("Failed to open link.");
	} finally {
		act(() => setup.renderer.destroy());
	}
});
