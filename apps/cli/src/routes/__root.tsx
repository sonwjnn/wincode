import { TextAttributes } from "@opentui/core";
import {
	createRootRoute,
	Outlet,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect, useReducer } from "react";

export const Route = createRootRoute({
	component: RootLayout,
	notFoundComponent: NotFound,
});

function NotFound() {
	return (
		<box alignItems="center" flexGrow={1} justifyContent="center">
			<box alignItems="center" flexDirection="column">
				<text attributes={TextAttributes.BOLD} fg="red">
					Screen Not Found
				</text>
				<text attributes={TextAttributes.DIM}>
					Press [1] to go back to the home screen
				</text>
			</box>
		</box>
	);
}

function RootLayout() {
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
		<box flexDirection="column" flexGrow={1}>
			<box
				border={["bottom"]}
				borderStyle="single"
				flexDirection="row"
				justifyContent="space-between"
				paddingLeft={1}
				paddingRight={1}
			>
				<text attributes={TextAttributes.BOLD}>WinCode</text>
				<text attributes={TextAttributes.DIM}>Current: {currentPath}</text>
			</box>

			<box flexGrow={1} padding={1}>
				<Outlet key={currentPath} />
			</box>
		</box>
	);
}
