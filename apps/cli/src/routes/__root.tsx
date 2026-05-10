import { type KeyEvent, TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import {
	createRootRoute,
	Outlet,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { useReducer } from "react";

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

// Root layout component with navigation
function RootLayout() {
	const router = useRouter();
	const renderer = useRenderer();
	const [, forceUpdate] = useReducer((x) => x + 1, 0);

	const currentPath = useRouterState({
		select: (s) => s.location.pathname,
	});

	useKeyboard(async (event: KeyEvent) => {
		if (event.name === "1") {
			await router.navigate({ to: "/" });
			forceUpdate();
		}
		if (event.name === "2") {
			await router.navigate({ to: "/about" });
			forceUpdate();
		}
		if (event.name === "3") {
			await router.navigate({ to: "/settings" });
			forceUpdate();
		}
		if (event.name === "q") {
			renderer.destroy();
		}
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			{/* Header */}
			<box
				border={["bottom"]}
				borderStyle="single"
				flexDirection="row"
				justifyContent="space-between"
				paddingLeft={1}
				paddingRight={1}
			>
				<text attributes={TextAttributes.BOLD}>
					TanStack Router File-Based Demo
				</text>
				<text attributes={TextAttributes.DIM}>Current: {currentPath}</text>
			</box>

			{/* Main content area */}
			<box flexGrow={1} padding={1}>
				<Outlet />
			</box>

			{/* Footer navigation */}
			<box
				border={["top"]}
				borderStyle="single"
				flexDirection="row"
				gap={2}
				justifyContent="center"
				paddingBottom={1}
				paddingTop={1}
			>
				<text
					attributes={
						currentPath === "/"
							? // biome-ignore lint/suspicious/noBitwiseOperators: <>
								TextAttributes.BOLD | TextAttributes.UNDERLINE
							: TextAttributes.NONE
					}
				>
					[1] Home
				</text>
				<text
					attributes={
						currentPath === "/about"
							? // biome-ignore lint/suspicious/noBitwiseOperators: <>
								TextAttributes.BOLD | TextAttributes.UNDERLINE
							: TextAttributes.NONE
					}
				>
					[2] About
				</text>
				<text
					attributes={
						currentPath === "/settings"
							? // biome-ignore lint/suspicious/noBitwiseOperators: <>
								TextAttributes.BOLD | TextAttributes.UNDERLINE
							: TextAttributes.NONE
					}
				>
					[3] Settings
				</text>
				<text attributes={TextAttributes.DIM}>[q] Quit</text>
			</box>
		</box>
	);
}
