import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const bootSessionId = "";

const memoryHistory = createMemoryHistory({
	initialEntries: [bootSessionId ? `/sessions/${bootSessionId}` : "/"],
});

const router = createRouter({
	routeTree,
	history: memoryHistory,
	defaultPendingComponent: () => <text>Loading...</text>,
	defaultNotFoundComponent: () => <text>Not Found</text>,
	defaultErrorComponent: ({ error }) => (
		<box flexDirection="column">
			<text>Error</text>
			<text>{error.message}</text>
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
		mode?: string;
	}
}

function App() {
	return <RouterProvider router={router} />;
}

await router.load();

const renderer = await createCliRenderer({
	targetFps: 60,
	exitOnCtrlC: true,
});

createRoot(renderer).render(<App />);
