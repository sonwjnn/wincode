import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
// import { Toaster } from "@wincode-demo/ui/components/sonner";

import Header from "../components/header";
import appCss from "../index.css?url";

// biome-ignore lint/complexity/noBannedTypes: <>
export type RouterAppContext = {};

export const Route = createRootRouteWithContext<RouterAppContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "My App",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),

	component: RootDocument,
});

function RootDocument() {
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const showHeader = pathname !== "/login";

	return (
		<html className="dark" lang="en">
			<head>
				<HeadContent />
			</head>
			<body className="bg-neutral-950 text-white antialiased">
				<div className="min-h-svh bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_40%),linear-gradient(180deg,_rgba(255,255,255,0.02),_transparent_28%)]">
					{showHeader ? <Header /> : null}
					<Outlet />
				</div>
				{/* <Toaster richColors /> */}
				<TanStackRouterDevtools position="bottom-left" />
				<Scripts />
			</body>
		</html>
	);
}
