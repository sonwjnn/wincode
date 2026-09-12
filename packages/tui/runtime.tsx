import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { ThemedRoot } from "./app/layouts/themed-root";
import { routeTree } from "./routeTree.gen";
import {
	ThemeProvider,
	useTheme,
} from "./shared/providers/theme/theme-provider";
import { runTuiCleanup } from "./shared/runtime-lifecycle";

const PendingFallback = () => {
	const { colors } = useTheme();
	return <text fg={colors.text}>Loading...</text>;
};

const NotFoundFallback = () => {
	const { colors } = useTheme();
	return <text fg={colors.text}>Not Found</text>;
};

const ErrorFallback = ({ error }: { error: Error }) => {
	const { colors } = useTheme();
	return (
		<box flexDirection="column">
			<text fg={colors.error}>Error</text>
			<text fg={colors.text}>{error.message}</text>
		</box>
	);
};

const router = createRouter({
	defaultErrorComponent: ErrorFallback,
	defaultNotFoundComponent: NotFoundFallback,
	defaultPendingComponent: PendingFallback,
	history: createMemoryHistory({ initialEntries: ["/"] }),
	isServer: false,
	routeTree,
});

const App = () => (
	<ThemeProvider>
		<ThemedRoot>
			<RouterProvider router={router} />
		</ThemedRoot>
	</ThemeProvider>
);
const finishRenderer = async (
	destroy: () => void,
	exited: PromiseWithResolvers<number>
): Promise<void> => {
	try {
		await runTuiCleanup();
		destroy();
		exited.resolve(0);
	} catch (error) {
		destroy();
		exited.reject(error);
	}
};

export const runTui = async (): Promise<number> => {
	await router.load();
	// OpenTUI has no DOM Transitioner to acknowledge this render.
	router._rendered ??= [];

	const renderer = await createCliRenderer({
		exitOnCtrlC: false,
		targetFps: 60,
	});
	const exited = Promise.withResolvers<number>();
	const destroy = renderer.destroy.bind(renderer);
	let destroyed = false;
	renderer.destroy = () => {
		if (destroyed) {
			return;
		}
		destroyed = true;
		void finishRenderer(destroy, exited);
	};
	createRoot(renderer).render(<App />);
	return await exited.promise;
};

declare module "@tanstack/react-router" {
	// biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation requires an interface
	interface Register {
		router: typeof router;
	}
}
