import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const memoryHistory = createMemoryHistory({
	initialEntries: ["/"],
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
}

function App() {
	return <RouterProvider router={router} />;
}

await router.load();

const renderer = await createCliRenderer();
// renderer.console.show();
createRoot(renderer).render(<App />);
