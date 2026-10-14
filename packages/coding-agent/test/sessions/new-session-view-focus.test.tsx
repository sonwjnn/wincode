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
import type {
	CredentialStore,
	ModelStore,
	ProviderCollection,
} from "@wincode/ai/sdk";
import { act, useState } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { ConnectionsProvider } from "@/modules/connections";
import { ModelPricingProvider } from "@/modules/model-pricing";
import { createPluginPromptSelectionBridge } from "@/modules/plugins/prompt-selection";
import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { writeComposerDraft } from "@/modules/sessions/hooks/input-controller/draft-store";
import {
	createDefaultSessionProviderCollection,
	type InteractiveSessionProviderCollection,
} from "@/modules/sessions/provider-collection";
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
import { flushTestRenderer } from "../support/opentui";

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

const createHomeProviderCollection = (
	pluginRuntime?: PluginRuntime,
	openAIKey?: string
) => {
	const credentialStore: CredentialStore = {
		delete: () => undefined,
		get: (providerId) => (providerId === "openai" ? openAIKey : undefined),
		set: () => undefined,
	};
	const modelStore: ModelStore = {
		get: () => undefined,
		set: () => undefined,
	};
	return createDefaultSessionProviderCollection(pluginRuntime, undefined, {
		credentialStore,
		modelStore,
	});
};

const createTestHomeProviderCollection = (pluginRuntime?: PluginRuntime) =>
	createHomeProviderCollection(pluginRuntime);

const createConnectedHomeProviderCollection = (pluginRuntime?: PluginRuntime) =>
	createHomeProviderCollection(pluginRuntime, "fake-home-api-key");

const waitForHomeModelStatus = async (
	setup: TestRendererSetup
): Promise<void> => {
	await act(async () => {
		for (let attempt = 0; attempt < 30; attempt += 1) {
			await Bun.sleep(10);
			await setup.renderOnce();
			if (setup.captureCharFrame().includes("Stored default unavailable:")) {
				break;
			}
		}
		await setup.renderOnce();
	});
};

type HomeProviderCollectionFactory = (
	pluginRuntime?: PluginRuntime
) => Promise<InteractiveSessionProviderCollection>;

const renderHomeView = async (
	createProviderCollection: HomeProviderCollectionFactory
): Promise<TestRendererSetup> => {
	const workspace = process.cwd();
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: createRootRoute({}),
	});
	await router.load();
	writeComposerDraft("new-session", "");
	setInteractiveRuntimeContext({ args: [], cwd: workspace });
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
													<NewSessionView
														createProviderCollection={createProviderCollection}
													/>
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
	const setup = await testRender(app, { height: 24, width: 120 });
	await act(async () => {
		await Bun.sleep(20);
		await setup.renderOnce();
	});
	return setup;
};

describe("NewSessionView composer focus", () => {
	test("Home restores Provider snapshots before availability reads and closes its collection on unmount", async () => {
		const operations: string[] = [];
		const createCollection: HomeProviderCollectionFactory = async (
			pluginRuntime
		) => {
			const collection = await createHomeProviderCollection(pluginRuntime);
			const restoreModels = collection.restoreModels.bind(collection);
			const getAvailable = collection.getAvailable.bind(collection);
			const refreshModels: ProviderCollection["refreshModels"] = (...args) => {
				operations.push("refresh");
				return collection.refreshModels(...args);
			};
			return {
				...collection,
				restoreModels: async () => {
					operations.push("restore");
					await restoreModels();
				},
				getAvailable: async () => {
					operations.push("available");
					return getAvailable();
				},
				refreshModels,
				close: async () => {
					operations.push("close");
					await collection.close();
				},
			};
		};
		const setup = await renderHomeView(createCollection);
		let destroyed = false;
		try {
			await waitForHomeModelStatus(setup);
			await flushTestRenderer(setup, 3);
			const firstAvailabilityRead = operations.indexOf("available");
			expect(firstAvailabilityRead).toBeGreaterThan(0);
			expect(
				operations
					.slice(0, firstAvailabilityRead)
					.every((operation) => operation === "restore")
			).toBe(true);
			expect(operations).not.toContain("refresh");
			await act(() => setup.renderer.destroy());
			destroyed = true;
			await Bun.sleep(20);
			expect(
				operations.filter((operation) => operation === "close")
			).toHaveLength(1);
		} finally {
			if (!destroyed) {
				await act(() => setup.renderer.destroy());
			}
			setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
		}
	});

	test("Home unmount during restoration closes its ProviderCollection only once", async () => {
		const restorationStarted = Promise.withResolvers<void>();
		const finishRestoration = Promise.withResolvers<void>();
		const restorationFinished = Promise.withResolvers<void>();
		const closeFinished = Promise.withResolvers<void>();
		let closeCalls = 0;
		const createCollection: HomeProviderCollectionFactory = async (
			pluginRuntime
		) => {
			const collection = await createHomeProviderCollection(pluginRuntime);
			const restoreModels = collection.restoreModels.bind(collection);
			return {
				...collection,
				restoreModels: async () => {
					restorationStarted.resolve();
					try {
						await finishRestoration.promise;
						await restoreModels();
					} finally {
						restorationFinished.resolve();
					}
				},
				close: async () => {
					closeCalls += 1;
					try {
						await collection.close();
					} finally {
						closeFinished.resolve();
					}
				},
			};
		};
		const setup = await renderHomeView(createCollection);
		let destroyed = false;
		try {
			const restorationDidStart = await Promise.race([
				restorationStarted.promise.then(() => true),
				Bun.sleep(500).then(() => false),
			]);
			expect(restorationDidStart).toBe(true);
			await act(() => setup.renderer.destroy());
			destroyed = true;
			await closeFinished.promise;
			finishRestoration.resolve();
			await restorationFinished.promise;
			await Bun.sleep(0);
			expect(closeCalls).toBe(1);
		} finally {
			finishRestoration.resolve();
			if (!destroyed) {
				await act(() => setup.renderer.destroy());
			}
			setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
		}
	});

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
				<NewSessionView
					createProviderCollection={createConnectedHomeProviderCollection}
				/>
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
			await waitForHomeModelStatus(setup);
			await flushTestRenderer(setup, 3);
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

	test("Home preserves and marks its stored default unavailable instead of sending it through Catalog", async () => {
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
														<NewSessionView
															createProviderCollection={
																createTestHomeProviderCollection
															}
														/>
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
		const setup = await testRender(app, { height: 24, width: 120 });
		try {
			await waitForHomeModelStatus(setup);
			await flushTestRenderer(setup, 3);
			const storedDefault = `${defaultChatModelSelection.providerId}/${defaultChatModelSelection.modelId}`;
			expect(setup.captureCharFrame()).toContain(
				`Stored default unavailable: ${storedDefault}`
			);

			const composer = setup.renderer.root.findDescendantById(
				"new-session-view-composer"
			);
			if (!(composer instanceof TextareaRenderable)) {
				throw new Error("The Home composer did not render.");
			}
			await act(async () => {
				await setup.mockInput.typeText("do not send through Catalog");
				await setup.mockInput.pressEnter();
			});
			await flushTestRenderer(setup, 20);

			expect(router.state.location.pathname).toBe("/");
			expect(setup.captureCharFrame()).toContain(
				"explicitly select an available Provider SDK Model"
			);
		} finally {
			await act(() => setup.renderer.destroy());
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
														<NewSessionView
															createProviderCollection={
																createTestHomeProviderCollection
															}
														/>
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
});
