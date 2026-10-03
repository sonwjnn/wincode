import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	type ErrorComponentProps,
	RouterProvider,
} from "@tanstack/react-router";
import { act, type ErrorInfo, type ReactNode } from "react";
import { ErrorRecoveryProvider } from "@/shared/providers/error-recovery/error-recovery-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ErrorBoundary } from "@/shared/ui/error-boundary";
import { ErrorFallbackView } from "@/shared/ui/error-fallback";
import {
	createLoggerHome,
	withDebugProject,
} from "../../../utils/test/logger-home";

// Boundary logging must not append to the developer's real diagnostics file.
const loggerHome = await createLoggerHome("wincode-boundary-");

afterAll(async () => {
	await loggerHome.cleanup();
});

const flushUi = async (setup: TestRendererSetup): Promise<void> => {
	await act(async () => {
		await setup.flush({ maxPasses: 20 });
	});
	await setup.renderOnce();
};

const createControlledChild = () => {
	const control = { fail: true };
	return {
		Child() {
			if (control.fail) {
				throw new Error("first render failed");
			}
			return <text>healthy content</text>;
		},
		control,
	};
};

const createFailingChild = (error: Error) =>
	function FailingChild(): never {
		throw error;
	};

const renderRootBoundary = async (child: ReactNode, withLayer = false) => {
	const quitCodes: number[] = [];
	const content = (
		<ErrorRecoveryProvider
			quit={(exitCode) => {
				quitCodes.push(exitCode);
			}}
		>
			<ErrorBoundary
				renderFallback={({ error, reset }) => (
					<ErrorFallbackView error={error} reset={reset} scope="root" />
				)}
			>
				{child}
			</ErrorBoundary>
		</ErrorRecoveryProvider>
	);
	const setup = await testRender(
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			{withLayer ? (
				<KeyboardLayerProvider>{content}</KeyboardLayerProvider>
			) : (
				content
			)}
		</ThemeProvider>,
		{ height: 24, kittyKeyboard: true, width: 90 }
	);
	await flushUi(setup);
	return { quitCodes, setup };
};

afterEach(() => {
	delete process.env.WINCODE_DEBUG;
});

describe("root error boundary", () => {
	test("a render error shows the fallback with its message and the log location", async () => {
		const { Child } = createControlledChild();
		const { setup } = await renderRootBoundary(<Child />);
		try {
			const frame = await setup.waitForFrame((current) =>
				current.includes("Something went wrong")
			);
			expect(frame).toContain("first render failed");
			expect(frame).toContain("Press Enter to continue, Esc to quit.");
			expect(frame).toContain("Log: ");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("Enter re-renders the failed subtree instead of quitting", async () => {
		const { Child, control } = createControlledChild();
		const { quitCodes, setup } = await renderRootBoundary(<Child />);
		try {
			await setup.waitForFrame((frame) =>
				frame.includes("first render failed")
			);
			control.fail = false;
			await act(async () => {
				setup.mockInput.pressEnter();
			});
			await flushUi(setup);

			expect(
				await setup.waitForFrame((frame) => frame.includes("healthy content"))
			).toContain("healthy content");
			expect(quitCodes).toEqual([]);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("Esc quits with status 1", async () => {
		const Child = createFailingChild(new Error("persistent failure"));
		const { quitCodes, setup } = await renderRootBoundary(<Child />);
		try {
			await act(async () => {
				setup.mockInput.pressEscape();
			});
			await flushUi(setup);

			expect(quitCodes).toEqual([1]);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("Ctrl+C quits with status 1 when no keyboard layer owns it", async () => {
		const Child = createFailingChild(new Error("persistent failure"));
		const { quitCodes, setup } = await renderRootBoundary(<Child />);
		try {
			await act(async () => {
				setup.mockInput.pressKey("c", { ctrl: true });
			});
			await flushUi(setup);

			expect(quitCodes).toEqual([1]);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("renders under the keyboard layer without update loops and Esc quits", async () => {
		const { Child } = createControlledChild();
		const { quitCodes, setup } = await renderRootBoundary(<Child />, true);
		try {
			expect(
				await setup.waitForFrame((frame) =>
					frame.includes("Something went wrong")
				)
			).toContain("first render failed");

			await act(async () => {
				setup.mockInput.pressEscape();
			});
			await flushUi(setup);

			expect(quitCodes).toEqual([1]);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("Ctrl+C reaches the fallback through the keyboard layer responder chain", async () => {
		const { Child } = createControlledChild();
		const { quitCodes, setup } = await renderRootBoundary(<Child />, true);
		try {
			await setup.waitForFrame((frame) =>
				frame.includes("Something went wrong")
			);

			await act(async () => {
				setup.mockInput.pressKey("c", { ctrl: true });
			});
			await flushUi(setup);

			expect(quitCodes).toEqual([1]);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("a repeated occurrence of the same error reports its count", async () => {
		const Child = () => {
			throw new Error("occurrence failure");
		};
		const { setup } = await renderRootBoundary(<Child />);
		try {
			await act(async () => {
				setup.mockInput.pressEnter();
			});
			await flushUi(setup);

			expect(
				await setup.waitForFrame((frame) =>
					frame.includes("This error has occurred 2 times.")
				)
			).toContain("This error has occurred 2 times.");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("debug mode rethrows to the outer boundary instead of rendering the fallback", async () => {
		const Child = createFailingChild(new Error("first render failed"));
		await withDebugProject(loggerHome.home, async () => {
			const setup = await testRender(
				<ThemeProvider themeName={DEFAULT_THEME.name}>
					<ErrorRecoveryProvider quit={() => undefined}>
						<ErrorBoundary renderFallback={() => <text>outer caught</text>}>
							<ErrorBoundary
								renderFallback={({ error, reset }) => (
									<ErrorFallbackView error={error} reset={reset} scope="root" />
								)}
							>
								<Child />
							</ErrorBoundary>
						</ErrorBoundary>
					</ErrorRecoveryProvider>
				</ThemeProvider>,
				{ height: 24, kittyKeyboard: true, width: 90 }
			);
			try {
				const frame = await setup.waitForFrame((current) =>
					current.includes("outer caught")
				);
				expect(frame).not.toContain("Something went wrong");
			} finally {
				setup.renderer.destroy();
			}
		});
	});
});

describe("route error boundary", () => {
	const buildRouter = (onCatch: (error: Error, info: ErrorInfo) => void) => {
		const { Child, control } = createControlledChild();
		const router = createRouter({
			defaultErrorComponent: ({ error, reset }: ErrorComponentProps) => (
				<ErrorFallbackView error={error} reset={reset} scope="route" />
			),
			defaultOnCatch: onCatch,
			history: createMemoryHistory({ initialEntries: ["/"] }),
			isServer: false,
			routeTree: createRootRoute({ component: Child }),
			scrollRestoration: false,
		});
		return { control, router };
	};

	test("a route render error shows the shared fallback and Enter resets the route", async () => {
		const onCatch = mock((_error: Error, _info: ErrorInfo) => undefined);
		const { control, router } = buildRouter(onCatch);
		await router.load();
		router._rendered ??= [];
		const setup = await testRender(
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ErrorRecoveryProvider quit={() => undefined}>
					<ErrorBoundary
						renderFallback={({ error, reset }) => (
							<ErrorFallbackView error={error} reset={reset} scope="root" />
						)}
					>
						<RouterProvider router={router} />
					</ErrorBoundary>
				</ErrorRecoveryProvider>
			</ThemeProvider>,
			{ height: 24, kittyKeyboard: true, width: 90 }
		);
		try {
			expect(
				await setup.waitForFrame((frame) =>
					frame.includes("first render failed")
				)
			).toContain("first render failed");

			control.fail = false;
			await act(async () => {
				setup.mockInput.pressEnter();
			});
			await flushUi(setup);

			expect(
				await setup.waitForFrame((frame) => frame.includes("healthy content"))
			).toContain("healthy content");
			expect(onCatch).toHaveBeenCalledTimes(1);
		} finally {
			setup.renderer.destroy();
		}
	});
});
