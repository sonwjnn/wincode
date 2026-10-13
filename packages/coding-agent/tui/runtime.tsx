import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { ErrorRecoveryProvider } from "../shared/providers/error-recovery/error-recovery-provider";
import {
	ThemeProvider,
	useTheme,
} from "../shared/providers/theme/theme-provider";
import { runInteractiveCleanup } from "../shared/runtime-lifecycle";
import { ErrorBoundary } from "../shared/ui/error-boundary";
import { ErrorFallbackView } from "../shared/ui/error-fallback";
import { logUnhandledUiError } from "../shared/utils/ui-error-log";
import type { InteractiveRendererSession } from "./interactive-renderer-session";
import { ThemedRoot } from "./layouts/themed-root";
import { routeTree } from "./routeTree.gen";

export { runProjectTrustPreflight } from "./project-trust-preflight";

// The terminal router has memory history and no browser viewport to scroll.
if (typeof Reflect.get(globalThis, "scrollTo") !== "function") {
	Reflect.set(globalThis, "scrollTo", () => undefined);
}

const PendingFallback = () => {
	const { colors } = useTheme();
	return <text fg={colors.text}>Loading...</text>;
};

const NotFoundFallback = () => {
	const { colors } = useTheme();
	return <text fg={colors.text}>Not Found</text>;
};

const router = createRouter({
	defaultErrorComponent: ({ error, reset }) => (
		<ErrorFallbackView error={error} reset={reset} scope="route" />
	),
	defaultNotFoundComponent: NotFoundFallback,
	defaultOnCatch: (error, errorInfo) => {
		logUnhandledUiError(error, "route", errorInfo.componentStack);
	},
	defaultPendingComponent: PendingFallback,
	history: createMemoryHistory({ initialEntries: ["/"] }),
	isServer: false,
	// Memory history has no browser window from which the router can infer origin.
	origin: "http://localhost",
	routeTree,
});

const App = ({ onQuit }: { onQuit: (exitCode: number) => void }) => (
	<ErrorRecoveryProvider quit={onQuit}>
		<ThemeProvider>
			<ThemedRoot>
				<ErrorBoundary
					renderFallback={({ error, reset }) => (
						<ErrorFallbackView error={error} reset={reset} scope="root" />
					)}
				>
					<RouterProvider router={router} />
				</ErrorBoundary>
			</ThemedRoot>
		</ThemeProvider>
	</ErrorRecoveryProvider>
);

const finishRenderer = async (
	destroy: () => void,
	exited: PromiseWithResolvers<number>,
	exitCode: number
): Promise<void> => {
	try {
		await runInteractiveCleanup();
		destroy();
		exited.resolve(exitCode);
	} catch (error) {
		destroy();
		exited.reject(error);
	}
};

export const runInteractive = async (
	session: InteractiveRendererSession
): Promise<number> => {
	try {
		await router.load();
		// OpenTUI has no DOM Transitioner to acknowledge this render.
		router._rendered ??= [];

		const renderer = session.renderer;
		const exited = Promise.withResolvers<number>();
		let requestedExitCode = 0;
		let destroyed = false;
		renderer.destroy = () => {
			if (destroyed) {
				return;
			}
			destroyed = true;
			void finishRenderer(session.destroy, exited, requestedExitCode);
		};
		const requestQuit = (exitCode: number) => {
			requestedExitCode = exitCode;
			renderer.destroy();
		};
		session.render(<App onQuit={requestQuit} />);
		return await exited.promise;
	} finally {
		session.destroy();
	}
};

declare module "@tanstack/react-router" {
	// biome-ignore lint/style/useConsistentTypeDefinitions: module augmentation requires an interface
	interface Register {
		router: typeof router;
	}
}
