import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { ConnectionsProvider, createConnections } from "@/modules/connections";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { ThemedRoot } from "./themed-root";

const connections = createConnections();

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
		<ConnectionsProvider connections={connections}>
			<ThemeProvider>
				<KeyboardLayerProvider>
					<PromptConfigProvider>
						<ToastProvider>
							<CopyOnSelect />
							<DialogProvider>
								<ThemedRoot>
									<Outlet key={currentPath} />
								</ThemedRoot>
							</DialogProvider>
						</ToastProvider>
					</PromptConfigProvider>
				</KeyboardLayerProvider>
			</ThemeProvider>
		</ConnectionsProvider>
	);
}
