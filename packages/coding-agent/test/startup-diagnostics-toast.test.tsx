import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { StartupDiagnosticsToast } from "@/tui/layouts/startup-diagnostics-toast";
import { flushTestRenderer } from "./support/opentui";

test("interactive startup diagnostics are presented inside the TUI", async () => {
	const setup = await testRender(
		<ThemeProvider>
			<ToastProvider>
				<StartupDiagnosticsToast
					messages={[
						"Project trust: project resources were omitted.",
						"Plugin: failed to load project helper.",
					]}
				/>
			</ToastProvider>
		</ThemeProvider>,
		{ height: 24, width: 100 }
	);
	try {
		await flushTestRenderer(setup, 3);
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Project trust: project resources were omitted.");
		expect(frame).toContain("Plugin: failed to load project helper.");
	} finally {
		await setup.renderer.destroy();
	}
});
