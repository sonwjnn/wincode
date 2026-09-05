#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	ThemeProvider,
	useTheme,
} from "@/shared/providers/theme/theme-provider";
import { ThemedRoot } from "./app/layouts/themed-root";
import { routeTree } from "./routeTree.gen";

const bootSessionId = "";

const memoryHistory = createMemoryHistory({
	initialEntries: [bootSessionId ? `/sessions/${bootSessionId}` : "/"],
});

const router = createRouter({
	routeTree,
	history: memoryHistory,
	isServer: false,
	defaultPendingComponent: PendingFallback,
	defaultNotFoundComponent: NotFoundFallback,
	defaultErrorComponent: ErrorFallback,
});

function PendingFallback() {
	const { colors } = useTheme();
	return <text fg={colors.text}>Loading...</text>;
}
function NotFoundFallback() {
	const { colors } = useTheme();
	return <text fg={colors.text}>Not Found</text>;
}
function ErrorFallback({ error }: { error: Error }) {
	const { colors } = useTheme();
	return (
		<box flexDirection="column">
			<text fg={colors.error}>Error</text>
			<text fg={colors.text}>{error.message}</text>
		</box>
	);
}

declare module "@tanstack/react-router" {
	// biome-ignore lint/style/useConsistentTypeDefinitions: <>
	interface Register {
		router: typeof router;
	}

	// biome-ignore lint/style/useConsistentTypeDefinitions: <>
	interface HistoryState {
		agent?: string;
		autoStart?: boolean;
		initialMessage?: unknown;
		mode?: string;
	}
}

function App() {
	return (
		<ThemeProvider>
			<ThemedRoot>
				<RouterProvider router={router} />
			</ThemedRoot>
		</ThemeProvider>
	);
}

await router.load();
// OpenTUI is interactive but has no DOM, so TanStack Router's browser-only
// Transitioner is not mounted to initialize this render acknowledgement.
router._rendered ??= [];

const renderer = await createCliRenderer({
	targetFps: 60,
	exitOnCtrlC: false,
});

createRoot(renderer).render(<App />);
