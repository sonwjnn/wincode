import { afterAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { TextareaRenderable } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import {
	type ConnectionProviderSummary,
	type Connections,
	createConnections,
} from "@wincode/ai/connections";
import { defaultChatModelSelection } from "@wincode/ai/models";
import { act, useState } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { ConnectionsProvider } from "@/modules/connections";
import { ModelPricingProvider } from "@/modules/model-pricing";
import { createPluginPromptSelectionBridge } from "@/modules/plugins/prompt-selection";
import { createPluginRuntime } from "@/modules/plugins/runtime";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { writeComposerDraft } from "@/modules/sessions/hooks/input-controller/draft-store";
import { NewSessionView } from "@/modules/sessions/ui/views/new-session-view";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import { CommandControllerProvider } from "@/tui/commands/command-controller-provider";

const previousLocalDatabasePath = process.env.WINCODE_LOCAL_DB_PATH;
process.env.WINCODE_LOCAL_DB_PATH = ":memory:";

// The in-memory override is file-wide, so hand the previous value back before
// another test file observes it.
afterAll(() => {
	if (previousLocalDatabasePath === undefined) {
		delete process.env.WINCODE_LOCAL_DB_PATH;
	} else {
		process.env.WINCODE_LOCAL_DB_PATH = previousLocalDatabasePath;
	}
});

const connectedOpenAIProvider: ConnectionProviderSummary = {
	connected: true,
	connectionMethod: "api-key",
	displayName: "OpenAI",
	id: "openai",
	methods: ["api-key"],
};

const createConnectedConnections = (): Connections => ({
	...createConnections(),
	listProviders: async () => [connectedOpenAIProvider],
});

describe("NewSessionView composer focus", () => {
	test("Plugin selection is unavailable after a route unmounts its composer", async () => {
		const workspace = process.cwd();
		const router = createRouter({
			history: createMemoryHistory({ initialEntries: ["/"] }),
			routeTree: createRootRoute({}),
		});
		await router.load();
		writeComposerDraft("new-session", "");

		const bridge = createPluginPromptSelectionBridge();
		const pluginRuntime = createPluginRuntime([], [], [], [], bridge);
		setInteractiveRuntimeContext({
			args: [],
			cwd: workspace,
			pluginRuntime,
		});
		let leaveComposer: (() => void) | undefined;
		function SessionRoute() {
			const [composerVisible, setComposerVisible] = useState(true);
			leaveComposer = () => setComposerVisible(false);
			return composerVisible ? (
				<NewSessionView />
			) : (
				<text>Loading session...</text>
			);
		}
		const app = (
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{
						configStore: createConfigStore({
							fs: {
								readFile: async () =>
									Promise.reject(
										Object.assign(new Error("Test config is unavailable."), {
											code: "ENOENT",
										})
									),
							},
						}),
						homeRoot: os.homedir(),
						workspace,
					}}
				>
					<ToastProvider>
						<ConnectionsProvider connections={createConnectedConnections()}>
							<AgentRegistryProvider>
								<KeyboardLayerProvider>
									<PromptConfigProvider>
										<ModelPricingProvider pricing={{}}>
											<DialogProvider>
												<RouterContextProvider router={router}>
													<CommandControllerProvider>
														<SessionRoute />
													</CommandControllerProvider>
												</RouterContextProvider>
											</DialogProvider>
										</ModelPricingProvider>
									</PromptConfigProvider>
								</KeyboardLayerProvider>
							</AgentRegistryProvider>
						</ConnectionsProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>
		);
		const setup = await testRender(app, { height: 24, width: 100 });
		try {
			await act(async () => {
				await Bun.sleep(20);
				await setup.renderOnce();
			});
			let modelSelected = false;
			await act(async () => {
				modelSelected = await bridge.setModel(defaultChatModelSelection);
			});
			expect(modelSelected).toBe(true);
			const leaveActiveComposer = leaveComposer;
			if (leaveActiveComposer === undefined) {
				throw new Error("The session route did not render.");
			}
			await act(async () => {
				leaveActiveComposer();
				await setup.renderOnce();
			});
			await expect(bridge.setModel(defaultChatModelSelection)).resolves.toBe(
				false
			);
		} finally {
			await act(async () => setup.renderer.destroy());
			setInteractiveRuntimeContext({ args: [], cwd: workspace });
			await pluginRuntime.shutdown();
		}
	});

	test("returns focus after pointer movement and a background click without moving the caret", async () => {
		const workspace = process.cwd();
		const router = createRouter({
			history: createMemoryHistory({ initialEntries: ["/"] }),
			routeTree: createRootRoute({}),
		});
		await router.load();
		writeComposerDraft("new-session", "");

		const app = (
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{
						configStore: createConfigStore({
							fs: {
								readFile: async () =>
									Promise.reject(
										Object.assign(new Error("Test config is unavailable."), {
											code: "ENOENT",
										})
									),
							},
						}),
						homeRoot: os.homedir(),
						workspace,
					}}
				>
					<ToastProvider>
						<ConnectionsProvider connections={createConnections()}>
							<AgentRegistryProvider>
								<KeyboardLayerProvider>
									<PromptConfigProvider>
										<ModelPricingProvider pricing={{}}>
											<DialogProvider>
												<RouterContextProvider router={router}>
													<CommandControllerProvider>
														<NewSessionView />
													</CommandControllerProvider>
												</RouterContextProvider>
											</DialogProvider>
										</ModelPricingProvider>
									</PromptConfigProvider>
								</KeyboardLayerProvider>
							</AgentRegistryProvider>
						</ConnectionsProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>
		);
		let renderedSetup: TestRendererSetup | undefined;
		await act(async () => {
			const mounted = await testRender(app, { height: 24, width: 100 });
			renderedSetup = mounted;
			await Bun.sleep(20);
			await mounted.renderOnce();
		});
		if (renderedSetup === undefined) {
			throw new Error("The new-session view did not render.");
		}
		const setup = renderedSetup;

		try {
			const composer = setup.renderer.root.findDescendantById(
				"new-session-view-composer"
			);
			expect(composer).toBeInstanceOf(TextareaRenderable);
			if (!(composer instanceof TextareaRenderable)) {
				throw new Error(
					"The new-session composer did not receive startup focus."
				);
			}
			expect(setup.renderer.currentFocusedRenderable).toBe(composer);
			await setup.flush({ maxPasses: 20 });
			// The first prompt must use the same full-width, bottom-docked input
			// area as an active session, rather than floating beneath the logo.
			const frame = setup.captureCharFrame().split("\n");
			const composerBorderLine = frame.findIndex(
				(line) => line.includes("╭") && line.includes("╮")
			);
			expect(composerBorderLine).toBeGreaterThanOrEqual(14);
			expect(frame[composerBorderLine]?.indexOf("╮")).toBeGreaterThan(85);

			await act(async () => {
				await setup.mockInput.typeText("before");
			});
			expect(composer.cursorOffset).toBe(6);
			// Commit the edited draft frame before injecting pointer input.
			await setup.flush({ maxPasses: 20 });

			await act(async () => {
				composer.blur();
				const position = setup.mockMouse.getCurrentPosition();
				const targetX = position.x === 99 ? 98 : 99;
				// Avoid a no-op move and target the view's blank top-right area.
				await setup.mockMouse.moveTo(targetX, 0);
			});
			await setup.flush({ maxPasses: 20 });
			expect(setup.renderer.currentFocusedRenderable?.id ?? null).toBe(
				composer.id
			);

			await act(async () => {
				composer.blur();
				await setup.mockMouse.pressDown(0, 0);
				await setup.mockMouse.release(0, 0);
				await setup.mockInput.typeText("-after");
			});
			await act(async () => {
				await setup.renderOnce();
			});

			expect(composer.plainText).toBe("before-after");
			expect(composer.cursorOffset).toBe(12);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("renders the untrusted project notice below the composer", async () => {
		const workspace = process.cwd();
		const router = createRouter({
			history: createMemoryHistory({ initialEntries: ["/"] }),
			routeTree: createRootRoute({}),
		});
		await router.load();
		writeComposerDraft("new-session", "");

		const app = (
			<ThemeProvider themeName={DEFAULT_THEME.name}>
				<ConfigProvider
					value={{
						configStore: createConfigStore({
							fs: {
								readFile: async () =>
									Promise.reject(
										Object.assign(new Error("Test config is unavailable."), {
											code: "ENOENT",
										})
									),
							},
						}),
						homeRoot: os.homedir(),
						trustedProjectRoots: [],
						untrustedProjectRoots: [workspace],
						workspace,
					}}
				>
					<ToastProvider>
						<ConnectionsProvider connections={createConnectedConnections()}>
							<AgentRegistryProvider>
								<KeyboardLayerProvider>
									<PromptConfigProvider>
										<ModelPricingProvider pricing={{}}>
											<DialogProvider>
												<RouterContextProvider router={router}>
													<CommandControllerProvider>
														<NewSessionView />
													</CommandControllerProvider>
												</RouterContextProvider>
											</DialogProvider>
										</ModelPricingProvider>
									</PromptConfigProvider>
								</KeyboardLayerProvider>
							</AgentRegistryProvider>
						</ConnectionsProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>
		);
		const setup = await testRender(app, { height: 30, width: 100 });
		try {
			await act(async () => {
				await Bun.sleep(20);
				await setup.renderOnce();
			});
			const composer = setup.renderer.root.findDescendantById(
				"new-session-view-composer"
			);
			expect(composer).toBeInstanceOf(TextareaRenderable);
			if (!(composer instanceof TextareaRenderable)) {
				throw new Error("The new-session composer did not render.");
			}
			const lines = setup.captureCharFrame().split("\n");
			const noticeLine = lines.findIndex((line) =>
				line.includes("This project is not trusted.")
			);
			expect(noticeLine).toBeGreaterThanOrEqual(
				composer.screenY + composer.height
			);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});
});
