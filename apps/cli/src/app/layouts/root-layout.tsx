import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { DialogProvider } from "@/shared/terminal/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/terminal/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/terminal/theme/theme-provider";
import { ToastProvider } from "@/shared/terminal/toast/toast-provider";
import { ThemedRoot } from "./themed-root";

export function RootLayout() {
	const router = useRouter();
	const [, forceUpdate] = useReducer((x) => x + 1, 0);

	const currentPath = useRouterState({
		select: (s) => s.location.pathname,
	});

	useEffect(() => {
		const updateAfterLoadStarts = () => {
			setTimeout(forceUpdate, 0);
		};

		const unsubscribeBeforeLoad = router.subscribe("onBeforeLoad", () => {
			updateAfterLoadStarts();
		});
		const unsubscribeResolved = router.subscribe("onResolved", () => {
			updateAfterLoadStarts();
		});

		return () => {
			unsubscribeBeforeLoad();
			unsubscribeResolved();
		};
	}, [router]);

	return (
		<ThemeProvider>
			<KeyboardLayerProvider>
				<PromptConfigProvider>
					<ToastProvider>
						<DialogProvider>
							<ThemedRoot>
								<Outlet key={currentPath} />
							</ThemedRoot>
						</DialogProvider>
					</ToastProvider>
				</PromptConfigProvider>
			</KeyboardLayerProvider>
		</ThemeProvider>
	);
}
