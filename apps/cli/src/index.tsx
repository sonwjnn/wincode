import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { AppRouter } from "@wincode/api/routers/index";
import { env } from "@wincode/env/cli";
import { routeTree } from "./routeTree.gen";

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error) => {
			console.error("[Query Error]", error.message);
		},
	}),
	defaultOptions: { queries: { staleTime: 60 * 1000 } },
});

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${env.SERVER_URL}/trpc`,
		}),
	],
});

const trpc = createTRPCOptionsProxy({
	client: trpcClient,
	queryClient,
});

const memoryHistory = createMemoryHistory({
	initialEntries: ["/"],
});

const router = createRouter({
	routeTree,
	history: memoryHistory,
	context: { trpc, queryClient },
	defaultPendingComponent: () => <text>Loading...</text>,
	defaultNotFoundComponent: () => <text>Not Found</text>,
	Wrap: ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
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
renderer.console.show();
createRoot(renderer).render(<App />);
