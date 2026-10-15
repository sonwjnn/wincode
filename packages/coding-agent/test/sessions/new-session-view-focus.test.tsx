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
import { fromPartial } from "@total-typescript/shoehorn";
import { type AgentId, agentIdSchema } from "@wincode/agent-core";
import type {
	CredentialStore,
	ModelStore,
	Provider,
	ProviderCollection,
	ProviderModel,
} from "@wincode/ai/sdk";
import { act, useState } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { createPluginPromptSelectionBridge } from "@/modules/plugins/prompt-selection";
import type { PluginAgentRegistration } from "@/modules/plugins/public";
import {
	createPluginRuntime,
	type PluginProviderDescriptor,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { pluginProviderStorageId } from "@/modules/providers/provider-stores";
import { writeComposerDraft } from "@/modules/sessions/hooks/input-controller/draft-store";
import {
	createDefaultSessionProviderCollection,
	type InteractiveSessionProviderCollection,
} from "@/modules/sessions/provider-collection";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import { NewSessionView } from "@/modules/sessions/ui/views/new-session-view";
import { ConfigProvider } from "@/shared/config/config-provider";
import {
	type ConfigRuntime,
	type ConfigSnapshot,
	createConfigStore,
} from "@/shared/config/config-store";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ThemeProvider } from "@/shared/providers/theme/theme-provider";
import { DEFAULT_THEME } from "@/shared/providers/theme/themes";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { setInteractiveRuntimeContext } from "@/shared/runtime-context";
import { CommandControllerProvider } from "@/tui/commands/command-controller-provider";
import { modelId } from "../support/identifiers";
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

type AgentProviderFixture = Readonly<{
	agentId: AgentId;
	credentialStorageId: string;
	model: ProviderModelSelection;
	pluginRuntime: PluginRuntime;
	providerConstructions: () => number;
}>;

const createAgentProviderFixture = (
	options: Readonly<{
		availableModelId?: string;
		operations?: string[];
		ownerCount?: number;
	}> = {}
): AgentProviderFixture => {
	const providerId = "interactive-agent-provider";
	const pinnedModelId = modelId("interactive-agent-model");
	const agentId = agentIdSchema.parse("interactive-pinned-agent");
	const model: ProviderModelSelection = {
		modelId: pinnedModelId,
		providerId,
	};
	const availableModel: ProviderModel = fromPartial<ProviderModel>({
		capabilities: ["text", "tools"],
		modelId:
			options.availableModelId === undefined
				? pinnedModelId
				: modelId(options.availableModelId),
		providerId,
		protocolId: "fake-interactive-agent-provider",
	});
	let providerConstructionCount = 0;
	const registrations = Array.from(
		{ length: options.ownerCount ?? 1 },
		(_, index): PluginProviderDescriptor => ({
			connect: async () => undefined,
			createProvider: () => {
				providerConstructionCount += 1;
				options.operations?.push("provider");
				return fromPartial<Provider>({
					id: providerId,
					models: [availableModel],
					resolveAuthorization: () => ({ authorization: { fake: true } }),
					async *streamChat() {
						yield { type: "finish" };
					},
				});
			},
			displayName: `Fake Interactive Provider ${index}`,
			pluginId: `interactive-provider-plugin-${index}`,
			providerId,
			sourceIdentity: `fake-interactive-provider-source-${index}`,
			sourcePath: `/trusted/plugins/interactive-provider-${index}.ts`,
		})
	);
	const agentRegistration: PluginAgentRegistration = {
		agent: {
			description: "Uses one exact Provider Model pin.",
			displayName: "Interactive Pinned Agent",
			id: agentId,
			instructions: "Use the selected Provider Model.",
			role: "primary",
		},
		model: `${providerId}/${pinnedModelId}`,
		source: {
			path: "/trusted/plugins/interactive-agent.md",
			scope: "user",
		},
	};
	const plugins = [
		{
			agents: [agentRegistration],
			commands: [],
			id: "interactive-agent-plugin",
			providers: registrations.slice(0, 1),
			sourcePath: "/trusted/plugins/interactive-agent.ts",
			tools: [],
			workspace: process.cwd(),
		},
		...registrations.slice(1).map((registration, index) => ({
			commands: [],
			id: `interactive-duplicate-plugin-${index}`,
			providers: [registration],
			sourcePath: registration.sourcePath,
			tools: [],
			workspace: process.cwd(),
		})),
	];
	return {
		agentId,
		credentialStorageId: pluginProviderStorageId({
			pluginId: "interactive-provider-plugin-0",
			providerId,
			sourceIdentity: "fake-interactive-provider-source-0",
		}),
		model,
		pluginRuntime: createPluginRuntime(plugins, []),
		providerConstructions: () => providerConstructionCount,
	};
};

const createTrackedHomeProviderCollectionFactory =
	(
		operations: string[],
		credentialStorageId: string,
		counters: { collectionConstructions: number; storeConstructions: number },
		registrationMetadata:
			| "authoritative"
			| "missing"
			| "mismatched" = "authoritative"
	): HomeProviderCollectionFactory =>
	async (pluginRuntime) => {
		counters.collectionConstructions += 1;
		operations.push("provider-collection");
		counters.storeConstructions += 1;
		const collection = await createDefaultSessionProviderCollection(
			pluginRuntime,
			undefined,
			{
				credentialStore: {
					delete: () => undefined,
					get: (candidateProviderId) => {
						operations.push(`credential:${candidateProviderId}`);
						return candidateProviderId === credentialStorageId
							? { token: "fake-provider-credential" }
							: undefined;
					},
					set: () => undefined,
				},
				modelStore: {
					get: () => {
						operations.push("model-store");
						return;
					},
					set: () => undefined,
				},
			}
		);
		const {
			getPluginProviderRegistrations,
			...collectionWithoutRegistrationReader
		} = collection;
		const restoreModels = collection.restoreModels.bind(collection);
		const getAvailable = collection.getAvailable.bind(collection);
		return {
			...collectionWithoutRegistrationReader,
			...(registrationMetadata === "missing"
				? {}
				: {
						getPluginProviderRegistrations:
							registrationMetadata === "mismatched"
								? () => []
								: getPluginProviderRegistrations,
					}),
			restoreModels: async () => {
				operations.push("restore-models");
				await restoreModels();
			},
			getAvailable: async (providerId) => {
				operations.push("availability");
				operations.push(`availability-provider:${providerId ?? "<all>"}`);
				return await getAvailable(providerId);
			},
		};
	};

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
) => Promise<
	ProviderCollection &
		Partial<
			Pick<
				InteractiveSessionProviderCollection,
				"getPluginProviderRegistrations"
			>
		>
>;

type HomeViewOptions = Readonly<{
	defaultAgentId?: AgentId;
	pluginRuntime?: PluginRuntime;
}>;

const renderHomeView = async (
	createProviderCollection: HomeProviderCollectionFactory,
	options: HomeViewOptions = {}
): Promise<TestRendererSetup> => {
	const workspace = process.cwd();
	const router = createRouter({
		history: createMemoryHistory({ initialEntries: ["/"] }),
		routeTree: createRootRoute({}),
	});
	await router.load();
	writeComposerDraft("new-session", "");
	setInteractiveRuntimeContext({
		args: [],
		cwd: workspace,
		...(options.pluginRuntime === undefined
			? {}
			: { pluginRuntime: options.pluginRuntime }),
	});
	const configValue =
		options.defaultAgentId === undefined
			? {
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
				}
			: fromPartial<ConfigRuntime>({
					configStore: {
						getSnapshot: async () =>
							fromPartial<ConfigSnapshot>({
								diagnostics: [],
								document: { default_agent: options.defaultAgentId },
								sourceFor: () => undefined,
								sources: [],
							}),
					},
					homeRoot: os.homedir(),
					workspace,
				});
	const app = (
		<ThemeProvider themeName={DEFAULT_THEME.name}>
			<ConfigProvider value={configValue}>
				<ToastProvider>
					<AgentRegistryProvider>
						<KeyboardLayerProvider>
							<PromptConfigProvider>
								<DialogProvider>
									<RouterContextProvider router={router}>
										<CommandControllerProvider>
											<NewSessionView
												createProviderCollection={createProviderCollection}
											/>
										</CommandControllerProvider>
									</RouterContextProvider>
								</DialogProvider>
							</PromptConfigProvider>
						</KeyboardLayerProvider>
					</AgentRegistryProvider>
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

const waitForHomeFrame = async (
	setup: TestRendererSetup,
	text: string
): Promise<void> => {
	await act(async () => {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			await Bun.sleep(10);
			await setup.renderOnce();
			if (setup.captureCharFrame().includes(text)) {
				return;
			}
		}
	});
};

const submitHomePrompt = async (setup: TestRendererSetup): Promise<void> => {
	const composer = setup.renderer.root.findDescendantById(
		"new-session-view-composer"
	);
	if (!(composer instanceof TextareaRenderable)) {
		throw new Error("The Home composer did not render.");
	}
	await act(async () => {
		await setup.mockInput.typeText("Use the trusted Agent pin.");
		await setup.mockInput.pressEnter();
	});
	await flushTestRenderer(setup, 20);
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
				getAvailable: async (providerId) => {
					operations.push("available");
					operations.push(`availability-provider:${providerId ?? "<all>"}`);
					return getAvailable(providerId);
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
			expect(
				operations.filter((operation) =>
					operation.startsWith("availability-provider:")
				)
			).toEqual([
				`availability-provider:${DEFAULT_PROVIDER_MODEL_SELECTION.providerId}`,
			]);
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
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider>
									<DialogProvider>
										<RouterContextProvider router={router}>
											<CommandControllerProvider>
												<SessionRoute />
											</CommandControllerProvider>
										</RouterContextProvider>
									</DialogProvider>
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
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
				modelSelected = await bridge.setModel(DEFAULT_PROVIDER_MODEL_SELECTION);
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
			await expect(
				bridge.setModel(DEFAULT_PROVIDER_MODEL_SELECTION)
			).resolves.toBe(false);
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
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider>
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
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</ToastProvider>
				</ConfigProvider>
			</ThemeProvider>
		);
		const setup = await testRender(app, { height: 24, width: 120 });
		try {
			await waitForHomeModelStatus(setup);
			await flushTestRenderer(setup, 3);
			const storedDefault = `${DEFAULT_PROVIDER_MODEL_SELECTION.providerId}/${DEFAULT_PROVIDER_MODEL_SELECTION.modelId}`;
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
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider>
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
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
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

describe("NewSessionView pinned Plugin Agent model preflight", () => {
	test("binds a unique trusted Agent pin before availability and persists its owner", async () => {
		const operations: string[] = [];
		const fixture = createAgentProviderFixture({ operations });
		const counters = { collectionConstructions: 0, storeConstructions: 0 };
		const createCollection = createTrackedHomeProviderCollectionFactory(
			operations,
			fixture.credentialStorageId,
			counters
		);
		const store = getSessionStore();
		await store.resetSessionData();
		const setup = await renderHomeView(createCollection, {
			defaultAgentId: fixture.agentId,
			pluginRuntime: fixture.pluginRuntime,
		});
		try {
			await waitForHomeModelStatus(setup);
			await flushTestRenderer(setup, 3);
			const firstAvailability = operations.indexOf("availability");
			expect(firstAvailability).toBeGreaterThan(0);
			expect(operations.indexOf("provider-collection")).toBeLessThan(
				firstAvailability
			);
			expect(operations.indexOf("provider")).toBeLessThan(firstAvailability);
			expect(operations.indexOf("model-store")).toBeLessThan(firstAvailability);
			expect(operations).toContain(
				`availability-provider:${fixture.model.providerId}`
			);
			expect(operations).not.toContain("availability-provider:<all>");
			expect(fixture.providerConstructions()).toBe(1);

			await submitHomePrompt(setup);
			const sessions = await store.listSessions();
			const [session] = sessions;
			if (session === undefined) {
				throw new Error("The trusted Agent pin did not create a Session.");
			}
			expect(session.model).toEqual({
				...fixture.model,
				pluginProviderSource: {
					pluginId: "interactive-provider-plugin-0",
					sourceIdentity: "fake-interactive-provider-source-0",
				},
			});
		} finally {
			await act(() => setup.renderer.destroy());
			await fixture.pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
			await store.resetSessionData();
		}
	});

	for (const registrationMetadata of ["missing", "mismatched"] as const) {
		test(`rejects a trusted Agent pin before model access when Host registration metadata is ${registrationMetadata}`, async () => {
			const operations: string[] = [];
			const fixture = createAgentProviderFixture({ operations });
			const counters = {
				collectionConstructions: 0,
				storeConstructions: 0,
			};
			const setup = await renderHomeView(
				createTrackedHomeProviderCollectionFactory(
					operations,
					fixture.credentialStorageId,
					counters,
					registrationMetadata
				),
				{
					defaultAgentId: fixture.agentId,
					pluginRuntime: fixture.pluginRuntime,
				}
			);
			try {
				await waitForHomeFrame(setup, "do not match the current trusted");
				expect(setup.captureCharFrame()).toContain(
					"do not match the current trusted"
				);
				expect(operations).toContain("provider-collection");
				expect(operations).not.toContain("restore-models");
				expect(operations).not.toContain("model-store");
				expect(
					operations.some((operation) => operation.startsWith("credential:"))
				).toBe(false);
				expect(operations).not.toContain("availability");
				expect(fixture.providerConstructions()).toBe(1);
			} finally {
				await act(() => setup.renderer.destroy());
				await fixture.pluginRuntime.shutdown();
				setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
			}
		});
	}

	test("rejects an untrusted Agent pin before credential, store, or Provider construction", async () => {
		const operations: string[] = [];
		const fixture = createAgentProviderFixture({ operations, ownerCount: 0 });
		const counters = { collectionConstructions: 0, storeConstructions: 0 };
		const setup = await renderHomeView(
			createTrackedHomeProviderCollectionFactory(
				operations,
				fixture.credentialStorageId,
				counters
			),
			{
				defaultAgentId: fixture.agentId,
				pluginRuntime: fixture.pluginRuntime,
			}
		);
		try {
			await waitForHomeFrame(setup, "has no matching trusted source");
			expect(setup.captureCharFrame()).toContain(
				"has no matching trusted source"
			);
			expect(operations).toEqual([]);
			expect(counters).toEqual({
				collectionConstructions: 0,
				storeConstructions: 0,
			});
			expect(fixture.providerConstructions()).toBe(0);
		} finally {
			await act(() => setup.renderer.destroy());
			await fixture.pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
		}
	});

	test("rejects an ambiguous Agent pin before credential, store, or Provider construction", async () => {
		const operations: string[] = [];
		const fixture = createAgentProviderFixture({ operations, ownerCount: 2 });
		const counters = { collectionConstructions: 0, storeConstructions: 0 };
		const setup = await renderHomeView(
			createTrackedHomeProviderCollectionFactory(
				operations,
				fixture.credentialStorageId,
				counters
			),
			{
				defaultAgentId: fixture.agentId,
				pluginRuntime: fixture.pluginRuntime,
			}
		);
		try {
			await waitForHomeFrame(setup, "has no matching trusted source");
			expect(setup.captureCharFrame()).toContain(
				"has no matching trusted source"
			);
			expect(operations).toEqual([]);
			expect(counters).toEqual({
				collectionConstructions: 0,
				storeConstructions: 0,
			});
			expect(fixture.providerConstructions()).toBe(0);
		} finally {
			await act(() => setup.renderer.destroy());
			await fixture.pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
		}
	});

	test("does not infer a missing owner for a restored historical Agent pin", async () => {
		const operations: string[] = [];
		const fixture = createAgentProviderFixture({ operations });
		const counters = { collectionConstructions: 0, storeConstructions: 0 };
		const store = getSessionStore();
		await store.resetSessionData();
		await store.createEmptySession({ model: fixture.model });
		const setup = await renderHomeView(
			createTrackedHomeProviderCollectionFactory(
				operations,
				fixture.credentialStorageId,
				counters
			),
			{
				defaultAgentId: fixture.agentId,
				pluginRuntime: fixture.pluginRuntime,
			}
		);
		try {
			await waitForHomeFrame(setup, "has no matching trusted source");
			expect(setup.captureCharFrame()).toContain(
				"has no matching trusted source"
			);
			expect(operations).toEqual([]);
			expect(counters).toEqual({
				collectionConstructions: 0,
				storeConstructions: 0,
			});
			expect(fixture.providerConstructions()).toBe(0);
		} finally {
			await act(() => setup.renderer.destroy());
			await fixture.pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
			await store.resetSessionData();
		}
	});

	test("rejects a trusted pin when only a different exact model is invocable", async () => {
		const operations: string[] = [];
		const fixture = createAgentProviderFixture({
			availableModelId: "different-exact-model",
			operations,
		});
		const counters = { collectionConstructions: 0, storeConstructions: 0 };
		const store = getSessionStore();
		await store.resetSessionData();
		const setup = await renderHomeView(
			createTrackedHomeProviderCollectionFactory(
				operations,
				fixture.credentialStorageId,
				counters
			),
			{
				defaultAgentId: fixture.agentId,
				pluginRuntime: fixture.pluginRuntime,
			}
		);
		try {
			await waitForHomeModelStatus(setup);
			await submitHomePrompt(setup);
			await waitForHomeFrame(setup, "is unavailable");
			expect(setup.captureCharFrame().replaceAll(/\s+/gu, " ")).toContain(
				`Provider Model ${fixture.model.providerId}/${fixture.model.modelId} is unavailable.`
			);
			expect(operations).toContain("availability");
			expect(operations).toContain(
				`availability-provider:${fixture.model.providerId}`
			);
			expect(operations).not.toContain("availability-provider:<all>");
			expect(fixture.providerConstructions()).toBe(1);
			expect(await store.listSessions()).toEqual([]);
		} finally {
			await act(() => setup.renderer.destroy());
			await fixture.pluginRuntime.shutdown();
			setInteractiveRuntimeContext({ args: [], cwd: process.cwd() });
			await store.resetSessionData();
		}
	});
});
