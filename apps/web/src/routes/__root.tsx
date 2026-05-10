import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@wincode/api/routers/index";
import { Toaster } from "@wincode/ui/components/sonner";

import Header from "../components/header";

import appCss from "../index.css?url";

// biome-ignore lint/style/useConsistentTypeDefinitions: <>
export interface RouterAppContext {
	queryClient: QueryClient;
	trpc: TRPCOptionsProxy<AppRouter>;
}

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
	return (
		<html className="dark" lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<div className="grid h-svh grid-rows-[auto_1fr]">
					<Header />
					<Outlet />
				</div>
				<Toaster richColors />
				<TanStackRouterDevtools position="bottom-left" />
				<ReactQueryDevtools buttonPosition="bottom-right" position="bottom" />
				<Scripts />
			</body>
		</html>
	);
}
