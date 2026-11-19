import { expect, test, vi } from "bun:test";
import { testRender } from "@wincode/tui/testing";
import { act, useEffect } from "react";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import {
	ToastProvider,
	useToast,
} from "@/shared/providers/toast/toast-provider";

function ShowTimedNotification() {
	const { show } = useToast();
	useEffect(() => {
		show({
			duration: 50,
			message: "Temporary operation notice",
			variant: "success",
		});
	}, [show]);
	return null;
}

test("the host removes a timed notification from the rendered output", async () => {
	vi.useFakeTimers();
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<ToastProvider>
				<ShowTimedNotification />
			</ToastProvider>
		</ThemeProvider>,
		{ height: 8, width: 60 }
	);
	try {
		await setup.renderOnce();
		await setup.waitForVisualIdle();
		expect(setup.captureCharFrame()).toContain("Temporary operation notice");

		await act(() => vi.advanceTimersByTime(50));
		await setup.renderOnce();
		await setup.waitForVisualIdle();
		expect(setup.captureCharFrame()).not.toContain(
			"Temporary operation notice"
		);
	} finally {
		vi.useRealTimers();
		await act(async () => setup.renderer.destroy());
	}
});
