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
import { routeTree } from "./routeTree.gen";

const bootSessionId = "";

const memoryHistory = createMemoryHistory({
	initialEntries: [bootSessionId ? `/sessions/${bootSessionId}` : "/"],
});

const router = createRouter({
	routeTree,
	history: memoryHistory,
	defaultPendingComponent: () => {
		const { colors } = useTheme();
		return <text fg={colors.text}>Loading...</text>;
	},
	defaultNotFoundComponent: () => {
		const { colors } = useTheme();
		return <text fg={colors.text}>Not Found</text>;
	},
	defaultErrorComponent: ({ error }) => (
		<box flexDirection="column">
			<text fg={useTheme().colors.error}>Error</text>
			<text fg={useTheme().colors.text}>{error.message}</text>
		</box>
	),
});

declare module "@tanstack/react-router" {
	// biome-ignore lint/style/useConsistentTypeDefinitions: <>
	interface Register {
		router: typeof router;
	}

	// biome-ignore lint/style/useConsistentTypeDefinitions: <>
	interface HistoryState {
		autoStart?: boolean;
		mode?: string;
	}
}

function App() {
	return (
		<ThemeProvider>
			<RouterProvider router={router} />
		</ThemeProvider>
	);
}

await router.load();

const renderer = await createCliRenderer({
	targetFps: 60,
	exitOnCtrlC: false,
});

createRoot(renderer).render(<App />);
