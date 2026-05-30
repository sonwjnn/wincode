import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import { ThemedRoot } from "../layouts/themed-root";
import { PromptConfigProvider } from "../providers/prompt-config";
import { ThemeProvider } from "../providers/theme";

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
			<PromptConfigProvider>
				<ThemedRoot>
					<Outlet key={currentPath} />
				</ThemedRoot>
			</PromptConfigProvider>
		</ThemeProvider>
	);
}
