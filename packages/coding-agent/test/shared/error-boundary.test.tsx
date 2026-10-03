import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { act, type ErrorInfo, type ReactNode } from "react";

const loggedErrors: Array<{ error: unknown; scope: unknown }> = [];
const loggedInstances = new WeakSet<object>();
await mock.module("@/shared/utils/ui-error-log", () => ({
	logUnhandledUiError: (error: unknown, scope: unknown) => {
		if (typeof error === "object" && error !== null) {
			if (loggedInstances.has(error)) {
				return;
			}
			loggedInstances.add(error);
		}
		loggedErrors.push({ error, scope });
	},
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
	await import("@tanstack/react-router");
const { ErrorRecoveryProvider } = await import(
	"@/shared/providers/error-recovery/error-recovery-provider"
);
const { KeyboardLayerProvider } = await import(
	"@/shared/providers/keyboard-layer/keyboard-layer-provider"
);
const { ThemeProvider } = await import(
	"@/shared/providers/theme/theme-provider"
);
const { DEFAULT_THEME } = await import("@/shared/providers/theme/themes");
const { ErrorBoundary } = await import("@/shared/ui/error-boundary");
const { ErrorFallbackView } = await import("@/shared/ui/error-fallback");

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
	loggedErrors.length = 0;
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
		process.env.WINCODE_DEBUG = "1";
		const Child = createFailingChild(new Error("first render failed"));
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
			expect(loggedErrors).toHaveLength(1);
			expect(loggedErrors[0]?.scope).toBe("root");
		} finally {
			setup.renderer.destroy();
		}
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
			expect(loggedErrors).toEqual([]);
		} finally {
			setup.renderer.destroy();
		}
	});
});
