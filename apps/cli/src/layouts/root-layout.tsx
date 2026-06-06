import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { ThemedRoot } from "../layouts/themed-root";
import { DialogProvider } from "../providers/dialog";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { PromptConfigProvider } from "../providers/prompt-config";
import { ThemeProvider } from "../providers/theme";
import { ToastProvider } from "../providers/toast";

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
