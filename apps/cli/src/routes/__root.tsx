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
		<box
			flexDirection="column"
			flexGrow={1}
			height="100%"
			overflow="hidden"
			width="100%"
		>
			<box
				border={["bottom"]}
				borderStyle="single"
				flexDirection="row"
				flexShrink={0}
				justifyContent="space-between"
				paddingLeft={1}
				paddingRight={1}
				width="100%"
			>
				<text attributes={TextAttributes.BOLD}>WinCode</text>
				<text attributes={TextAttributes.DIM}>Current: {currentPath}</text>
			</box>

			<box
				flexDirection="column"
				flexGrow={1}
				height="100%"
				overflow="hidden"
				padding={1}
				width="100%"
			>
				<Outlet key={currentPath} />
			</box>
		</box>
	);
}
