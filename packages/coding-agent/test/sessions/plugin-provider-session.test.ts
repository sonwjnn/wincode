import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTurnEvent, toModelId } from "@wincode/agent-core";
import type { ModelStore, Provider, ProviderModel } from "@wincode/ai";
import type { ApplicationResourceLoader } from "@/modules/application/resource-loader";
import { loadPlugins } from "@/modules/plugins/loader";
import {
	createPluginRuntime as createPluginRuntimeFromPlugins,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import {
	createProviderSdkCredentialStore,
	createProviderSdkModelStore,
} from "@/modules/providers/provider-stores";
import {
	createSessionHostManager,
	getInteractiveSessionHostManager,
	resetInteractiveSessionHostManager,
} from "@/modules/sessions/host/session-host-manager";
import {
	openSessionServices,
	type SessionServices,
} from "@/modules/sessions/host/session-services";
import type { SessionHost } from "@/modules/sessions/host/types";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	createInteractiveSessionProviderCollection,
	type InteractiveSessionProviderCollection,
	pluginProvidersFromRuntime,
} from "@/modules/sessions/provider-collection";
import type { SessionSdkHandle } from "@/modules/sessions/sdk-contract";
import {
	type ConfigRuntime,
	createConfigStore,
} from "@/shared/config/config-store";
import {
	getInteractiveRuntimeContext,
	type StartInteractiveInput,
	setInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { createInteractiveRuntimeLifecycle } from "@/shared/runtime-lifecycle";
import { reloadInteractiveResources } from "@/tui/commands/reload-resources";
import { createInMemoryCredentialStore } from "../support/provider-stores";

const pluginProviderOwnerRestoreError = /Plugin Provider.*trusted source/i;

const pluginSource = (
	owner: string,
	expectedApiKey: string,
	streamStartedFile?: string,
	activityFile?: string,
	publishedModelId = `${owner}-model`
): string => `
export default (api) => {
  let activity = { authorization: 0, connect: 0, discovery: 0, stream: 0 };
  const recordActivity = async () => {
    const activityFile = ${JSON.stringify(activityFile ?? null)};
    if (activityFile !== null) await Bun.write(activityFile, JSON.stringify(activity));
  };
  const plugin = api.definePlugin({ id: "shared_provider_owner" });
  plugin.registerProvider({
    providerId: "shared_provider",
    displayName: "${owner} Provider",
    createProvider: () => ({
      id: "shared_provider",
      models: [],
      resolveAuthorization: async ({ credential }) => {
        activity.authorization += 1;
        await recordActivity();
        if (typeof credential !== "object" || credential === null ||
            !("apiKey" in credential) || credential.apiKey !== ${JSON.stringify(expectedApiKey)}) {
          return null;
        }
        return { authorization: { owner: ${JSON.stringify(owner)} } };
      },
      discoverModels: async () => {
        activity.discovery += 1;
        await recordActivity();
        return [{
          capabilities: ["text", "tools"],
          modelId: ${JSON.stringify(publishedModelId)},
          protocolId: "fake-plugin-provider",
          providerId: "shared_provider",
        }];
      },
      streamChat: async function* (_request, context) {
        activity.stream += 1;
        await recordActivity();
        if (${JSON.stringify(streamStartedFile ?? null)} !== null &&
            _request.messages.some(({ content }) => content.some((part) =>
              part.type === "text" && part.text.includes("hold provider for reload")))) {
          await Bun.write(${JSON.stringify(streamStartedFile ?? null)}, "started");
          await Bun.sleep(200);
        }
        yield { type: "text-delta", delta: "authorized:${owner}" };
        yield { type: "finish" };
      },
    }),
    connect: async ({ requestTextInput, signal }) => {
      activity.connect += 1;
      await recordActivity();
      const apiKey = await requestTextInput("Enter a fake Provider key", signal);
      return apiKey === undefined ? undefined : { apiKey };
    },
  });
};
`;

const createPluginRuntime = async (
	pluginPath: string,
	config: ConfigRuntime,
	userDataDir: string
): Promise<PluginRuntime> =>
	loadPlugins({
		cliPaths: [pluginPath],
		config,
		distributionPlugins: [],
		userDataDir,
	});

const send = async (
	handle: SessionSdkHandle,
	text: string,
	model?: ProviderModelSelection
): Promise<Readonly<{ output: string; terminal: AgentTurnEvent }>> => {
	const terminal = Promise.withResolvers<AgentTurnEvent>();
	let output = "";
	const unsubscribe = handle.onEvent((event) => {
		if (event.type === "text-delta") {
			output += event.delta;
		}
		if (
			event.type === "agent-turn-completed" ||
			event.type === "agent-turn-failed" ||
			event.type === "agent-turn-cancelled" ||
			event.type === "agent-turn-interrupted"
		) {
			terminal.resolve(event);
		}
	});
	try {
		const admission = await handle.prompt({
			...(model === undefined ? {} : { model }),
			text,
		});
		expect(admission?.rejected).toBe(false);
		return { output, terminal: await terminal.promise };
	} finally {
		unsubscribe?.();
	}
};

const modelFor = (
	modelId: string,
	pluginProviderSource?: Readonly<{ pluginId: string; sourceIdentity: string }>
) => ({
	modelId: toModelId(modelId),
	providerId: "shared_provider",
	...(pluginProviderSource === undefined
		? {}
		: {
				pluginProviderSource: {
					pluginId: pluginProviderSource.pluginId,
					sourceIdentity: pluginProviderSource.sourceIdentity,
				},
			}),
});

const textOfModels = (
	models: readonly ProviderModel[],
	providerId?: string
): readonly string[] =>
	models
		.filter(
			(model) => providerId === undefined || model.providerId === providerId
		)
		.map(({ modelId }) => modelId);

const assistantText = (messages: readonly SessionMessage[]): string => {
	let text = "";
	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const part of message.parts) {
			if (part.type === "text") {
				text += part.text;
			}
		}
	}
	return text;
};

const waitForHostIdle = async (host: SessionHost): Promise<void> => {
	const deadline = Date.now() + 4000;
	while (true) {
		const snapshot = host.getSnapshot();
		if (
			!(snapshot.turnActive || snapshot.isCompacting) &&
			snapshot.executions.length === 0 &&
			snapshot.queuedSubmissions.length === 0 &&
			snapshot.steeringMessages.length === 0
		) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error("The Session Host did not settle to idle.");
		}
		await Bun.sleep(5);
	}
};

test("Interactive Session connects and sends through the owner-scoped Plugin Provider composition", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-plugin-provider-session-")
	);
	const workspace = path.join(root, "workspace");
	const homeRoot = path.join(root, "home");
	const userDataDir = path.join(root, "user-data");
	const databasePath = path.join(root, "sessions.sqlite");
	const pluginAPath = path.join(root, "source-a", "provider.ts");
	const pluginBPath = path.join(root, "source-b", "provider.ts");
	const pluginBAliasPath = path.join(root, "source-b-alias", "provider.ts");
	const streamStartedFile = path.join(root, "provider-stream-started");
	const providerActivityFile = path.join(root, "provider-activity.json");
	const providerActivity = Bun.file(providerActivityFile);
	const failingPluginPath = path.join(root, "failing-source", "provider.ts");
	await Promise.all(
		[
			workspace,
			homeRoot,
			path.dirname(pluginAPath),
			path.dirname(pluginBPath),
			path.dirname(failingPluginPath),
			path.dirname(pluginBAliasPath),
		].map((directory) => fs.mkdir(directory, { recursive: true }))
	);
	await Promise.all([
		Bun.write(
			pluginAPath,
			pluginSource(
				"owner-a",
				"fake-key-a",
				streamStartedFile,
				undefined,
				"shared-owner-model"
			)
		),
		Bun.write(
			pluginBPath,
			pluginSource(
				"owner-b",
				"fake-key-b",
				undefined,
				providerActivityFile,
				"shared-owner-model"
			)
		),
		Bun.write(
			failingPluginPath,
			`export default (api) => {
				const plugin = api.definePlugin({ id: "shared_provider_owner" });
				plugin.registerProvider({
					providerId: "shared_provider",
					displayName: "Broken Provider",
					createProvider: () => { throw new Error("fake provider factory failure"); },
					connect: async () => undefined,
				});
			};`
		),
	]);
	await fs.symlink(pluginBPath, pluginBAliasPath);
	const configRuntime: ConfigRuntime = {
		configStore: createConfigStore({ homeRoot, trustedProjectRoots: [] }),
		cwd: workspace,
		homeRoot,
		workspace,
	};
	const pluginRuntimes: PluginRuntime[] = [];
	let services: SessionServices | undefined;
	let handle: SessionSdkHandle | undefined;
	let unsubscribeComposition: (() => void) | undefined;
	let reloadCandidate: PluginRuntime | undefined;
	let toastMessage = "";
	let previousRuntimeContext: StartInteractiveInput | undefined;
	try {
		previousRuntimeContext = getInteractiveRuntimeContext();
	} catch {
		// This test may run before Interactive Mode initializes its process context.
	}

	try {
		await resetInteractiveSessionHostManager();
		const runtimeA = await createPluginRuntime(
			pluginAPath,
			configRuntime,
			userDataDir
		);
		const runtimeB = await createPluginRuntime(
			pluginBAliasPath,
			configRuntime,
			userDataDir
		);
		const failingRuntime = await createPluginRuntime(
			failingPluginPath,
			configRuntime,
			userDataDir
		);
		pluginRuntimes.push(runtimeA, runtimeB, failingRuntime);
		expect(runtimeA.getProviderRegistrations()[0]?.sourceIdentity).toBe(
			await fs.realpath(pluginAPath)
		);
		expect(runtimeB.getProviderRegistrations()[0]?.sourceIdentity).toBe(
			await fs.realpath(pluginBPath)
		);
		expect(runtimeA.getProviderRegistrations()[0]?.sourceIdentity).not.toBe(
			runtimeB.getProviderRegistrations()[0]?.sourceIdentity
		);

		const manager = getInteractiveSessionHostManager(runtimeA);
		const credentialStore = createProviderSdkCredentialStore({ userDataDir });
		const modelStore = createProviderSdkModelStore({ userDataDir });
		const resourceLoader: ApplicationResourceLoader = {
			reload: async ({ current }) => ({
				configRuntime: current.configRuntime,
				diagnostics: [],
				pluginRuntime: reloadCandidate ?? current.pluginRuntime,
				pluginRuntimeChanged:
					reloadCandidate !== undefined &&
					reloadCandidate !== current.pluginRuntime,
			}),
		};
		setInteractiveRuntimeContext({
			args: [],
			configRuntime,
			cwd: workspace,
			pluginRuntime: runtimeA,
			resourceLoader,
		});
		const hostCollections: InteractiveSessionProviderCollection[] = [];
		services = await openSessionServices({
			policy: { cwd: workspace, databasePath, workspace },
			sources: {
				configRuntime: () => configRuntime,
				createProviderCollection: async (pluginRuntime, sessionId) => {
					const pluginProviders = pluginProvidersFromRuntime(
						pluginRuntime,
						sessionId
					);
					expect(pluginProviders).toHaveLength(1);
					const collection = await createInteractiveSessionProviderCollection({
						credentialStore,
						modelStore,
						pluginProviders,
					});
					hostCollections.push(collection);
					return collection;
				},
				pluginRuntime: () =>
					getInteractiveRuntimeContext().pluginRuntime ?? runtimeA,
				sessionHostManager: () => manager,
			},
		});
		const selectedA = modelFor("shared-owner-model", {
			pluginId: "shared_provider_owner",
			sourceIdentity:
				runtimeA.getProviderRegistrations()[0]?.sourceIdentity ?? "",
		});
		const sessionId = await services.sessionSdk.createEmptySession({
			model: selectedA,
		});
		let host = await manager.openHost({
			autoContinue: false,
			capabilities: services.capabilities,
			sessionId,
			view: false,
		});
		handle = await services.sessionSdk.openSession(sessionId, {
			autoContinue: false,
			view: true,
		});
		let hostCollection = hostCollections.at(-1);
		if (hostCollection === undefined) {
			throw new Error(
				"The Session Host did not create its ProviderCollection."
			);
		}
		expect(hostCollection.getPluginProviderRegistrations()).toHaveLength(1);
		let controller = host.providerController;
		if (controller === undefined) {
			throw new Error(
				"The Session Host did not create its ProviderController."
			);
		}
		const compositionRevisionBeforeReload =
			controller.getCompositionRevision?.();
		if (
			compositionRevisionBeforeReload === undefined ||
			controller.subscribeComposition === undefined
		) {
			throw new Error("The ProviderController has no composition revision.");
		}
		let compositionNotifications = 0;
		unsubscribeComposition = controller.subscribeComposition(() => {
			compositionNotifications += 1;
		});

		// Cancellation is an observable no-write: the Provider stays unavailable.
		expect(
			await controller.connectPluginProvider(
				"shared_provider",
				async () => undefined
			)
		).toBeUndefined();
		expect(await controller.getAvailableModels()).toEqual([]);
		const ownerAConnection = await controller.connectPluginProvider(
			"shared_provider",
			async (prompt) => {
				expect(prompt).toContain("fake Provider key");
				return "fake-key-a";
			}
		);
		if (ownerAConnection?.kind !== "connected") {
			throw new Error("The fake owner-A Provider did not connect.");
		}
		expect(textOfModels(ownerAConnection.models)).toEqual([
			"shared-owner-model",
		]);
		const firstSend = await send(handle, "use owner A");
		expect(firstSend.terminal).toMatchObject({ type: "agent-turn-completed" });
		expect(assistantText(host.agentSession.getSnapshot().transcript)).toContain(
			"authorized:owner-a"
		);
		// A live Provider send keeps the Host busy, so reload cannot swap its composition.
		const busyTurn = send(handle, "hold provider for reload");
		const waitStartedAt = Date.now();
		while (!(await Bun.file(streamStartedFile).exists())) {
			if (Date.now() - waitStartedAt > 5000) {
				throw new Error(
					"The fake Provider did not begin the held Session turn."
				);
			}
			await Bun.sleep(5);
		}
		reloadCandidate = runtimeB;
		await expect(
			reloadInteractiveResources({
				refreshAgentRegistry: () => undefined,
				reloadTheme: () => undefined,
				toast: { show: ({ message }) => (toastMessage = message) },
				lifecycle: createInteractiveRuntimeLifecycle(),
			})
		).rejects.toThrow("Session work is running");
		expect(getInteractiveRuntimeContext().pluginRuntime).toBe(runtimeA);
		expect(
			hostCollection.getPluginProviderRegistrations()[0]?.sourceIdentity
		).toBe(await fs.realpath(pluginAPath));
		expect((await busyTurn).terminal.type).toBe("agent-turn-completed");
		await waitForHostIdle(host);

		// Same-trust factory failure must leave the currently trusted Provider live.
		reloadCandidate = failingRuntime;
		await reloadInteractiveResources({
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: ({ message }) => (toastMessage = message) },
			lifecycle: createInteractiveRuntimeLifecycle(),
		});
		expect(getInteractiveRuntimeContext().pluginRuntime).toBe(runtimeA);
		expect(
			textOfModels(await controller.getKnownModels(), "shared_provider")
		).toEqual(["shared-owner-model"]);
		expect((await send(handle, "old owner still runs")).terminal.type).toBe(
			"agent-turn-completed"
		);
		await waitForHostIdle(host);
		expect(toastMessage).toContain(
			"previous trusted Plugin set and Provider composition were retained"
		);

		// A different canonical source with the same Plugin and Provider IDs cannot reuse A's data.
		reloadCandidate = runtimeB;
		await reloadInteractiveResources({
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: ({ message }) => (toastMessage = message) },
			lifecycle: createInteractiveRuntimeLifecycle(),
		});
		expect(controller.getCompositionRevision?.()).toBe(
			compositionRevisionBeforeReload + 1
		);
		expect(compositionNotifications).toBe(1);
		expect(getInteractiveRuntimeContext().pluginRuntime).toBe(runtimeB);
		expect(
			textOfModels(await controller.getKnownModels(), "shared_provider")
		).toEqual([]);
		expect(
			(await controller.getAvailableModels()).filter(
				({ providerId }) => providerId === "shared_provider"
			)
		).toEqual([]);
		const selectedB = modelFor("shared-owner-model", {
			pluginId: "shared_provider_owner",
			sourceIdentity:
				runtimeB.getProviderRegistrations()[0]?.sourceIdentity ?? "",
		});
		const ownerBConnection = await controller.connectPluginProvider(
			"shared_provider",
			async () => "fake-key-b"
		);
		if (ownerBConnection?.kind !== "connected") {
			throw new Error("The fake owner-B Provider did not connect.");
		}
		expect(textOfModels(ownerBConnection.models)).toEqual([
			"shared-owner-model",
		]);
		const activityBeforeChangedOwnerSelection: Readonly<{
			authorization: number;
			connect: number;
			discovery: number;
			stream: number;
		}> = await providerActivity.json();
		await expect(
			handle.prompt({ text: "do not redirect owner A selection to owner B" })
		).rejects.toThrow(pluginProviderOwnerRestoreError);
		await waitForHostIdle(host);
		expect(await providerActivity.json()).toEqual(
			activityBeforeChangedOwnerSelection
		);
		const ownerBAdmission = await handle.prompt({
			model: selectedB,
			text: "explicitly use owner B",
		});
		expect(ownerBAdmission?.rejected).toBe(false);
		await waitForHostIdle(host);
		await waitForHostIdle(host);
		expect(assistantText(host.agentSession.getSnapshot().transcript)).toContain(
			"authorized:owner-b"
		);
		const continuedOwnerB = await send(handle, "continue with owner B");
		expect(continuedOwnerB.terminal.type).toBe("agent-turn-completed");
		await waitForHostIdle(host);
		expect(assistantText(host.agentSession.getSnapshot().transcript)).toContain(
			"authorized:owner-b"
		);
		const latestEffectiveModel = (
			await services.store.listSessionRecords(sessionId)
		)
			.reverse()
			.flatMap(({ messages }) => messages)
			.find(({ role, metadata }) => role === "assistant" && metadata?.model)
			?.metadata?.model;
		expect(latestEffectiveModel).toEqual(selectedB);
		expect((await services.store.getSession(sessionId))?.model).toEqual(
			selectedB
		);

		// Restored effective turn records keep owner B bound through Session reopen.
		unsubscribeComposition?.();
		unsubscribeComposition = undefined;
		await handle.dispose();
		handle = undefined;
		host = await manager.openHost({
			autoContinue: false,
			capabilities: services.capabilities,
			sessionId,
			view: false,
		});
		hostCollection = hostCollections.at(-1);
		if (hostCollection === undefined) {
			throw new Error(
				"The restored Session Host did not create a ProviderCollection."
			);
		}
		controller = host.providerController;
		if (controller === undefined) {
			throw new Error("The restored Session Host has no ProviderController.");
		}
		const activityBeforeRestoredOwnerSelection = await providerActivity.json();
		handle = await services.sessionSdk.openSession(sessionId, {
			autoContinue: false,
			view: true,
		});
		const restoredOwnerBSend = await send(
			handle,
			"continue owner B after reopen"
		);
		expect(restoredOwnerBSend.terminal.type).toBe("agent-turn-completed");
		await waitForHostIdle(host);
		expect(assistantText(host.agentSession.getSnapshot().transcript)).toContain(
			"authorized:owner-b"
		);
		expect(await providerActivity.json()).not.toEqual(
			activityBeforeRestoredOwnerSelection
		);

		// A fresh ProviderCollection restores the canonical Plugin owner's cached Models.
		const reenabledB = await createPluginRuntime(
			pluginBAliasPath,
			configRuntime,
			userDataDir
		);
		pluginRuntimes.push(reenabledB);
		const reenabledCollection =
			await createInteractiveSessionProviderCollection({
				credentialStore,
				modelStore,
				pluginProviders: pluginProvidersFromRuntime(reenabledB),
			});
		await reenabledCollection.restoreModels();
		expect(
			textOfModels(reenabledCollection.getModels(), "shared_provider")
		).toEqual(["shared-owner-model"]);
		expect(
			textOfModels(await reenabledCollection.getAvailable(), "shared_provider")
		).toEqual(["shared-owner-model"]);
		await reenabledCollection.close();
	} finally {
		unsubscribeComposition?.();
		await services?.shutdown();
		await resetInteractiveSessionHostManager();
		await Promise.allSettled(
			pluginRuntimes.map((runtime) => runtime.shutdown())
		);
		setInteractiveRuntimeContext(
			previousRuntimeContext ?? { args: [], cwd: process.cwd() }
		);
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("a Plugin disabled by Session start failure has no Provider in that Session's Host", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-disabled-plugin-provider-")
	);
	const workspace = path.join(root, "workspace");
	const homeRoot = path.join(root, "home");
	const databasePath = path.join(root, "sessions.sqlite");
	await fs.mkdir(workspace, { recursive: true });
	const configRuntime: ConfigRuntime = {
		configStore: createConfigStore({ homeRoot, trustedProjectRoots: [] }),
		cwd: workspace,
		homeRoot,
		workspace,
	};
	let providerFactoryCalls = 0;
	let connectCalls = 0;
	const providerId = "session_disabled_provider";
	const sourcePath = path.join(root, "disabled-plugin.ts");
	const runtime = createPluginRuntimeFromPlugins(
		[
			{
				commands: [],
				id: "disabled-provider-plugin",
				onSessionStart: () => {
					throw new Error("fake Session initialization failure");
				},
				providers: [
					{
						connect: async () => {
							connectCalls += 1;
							return { apiKey: "fake-disabled-key" };
						},
						createProvider: () => {
							providerFactoryCalls += 1;
							const provider: Provider = {
								id: providerId,
								models: [],
								resolveAuthorization: () => ({ authorization: {} }),
								async *streamChat() {
									yield { type: "finish" };
								},
							};
							return provider;
						},
						displayName: "Disabled Provider",
						pluginId: "disabled-provider-plugin",
						providerId,
						sourceIdentity: sourcePath,
						sourcePath,
					},
				],
				sourcePath,
				tools: [],
				workspace,
			},
		],
		[]
	);
	const manager = createSessionHostManager(runtime);
	const credentials = new Map<string, unknown>();
	const snapshots = new Map<string, readonly ProviderModel[]>();
	const credentialStore = createInMemoryCredentialStore(credentials);
	const modelStore: ModelStore = {
		get: (id) => snapshots.get(id),
		set: (id, models) => {
			snapshots.set(id, models);
		},
	};
	let services: SessionServices | undefined;

	try {
		services = await openSessionServices({
			policy: { cwd: workspace, databasePath, workspace },
			sources: {
				configRuntime: () => configRuntime,
				createProviderCollection: (pluginRuntime, sessionId) =>
					createInteractiveSessionProviderCollection({
						credentialStore,
						modelStore,
						pluginProviders: pluginProvidersFromRuntime(
							pluginRuntime,
							sessionId
						),
					}),
				pluginRuntime: () => runtime,
				sessionHostManager: () => manager,
			},
		});
		const sessionId = await services.sessionSdk.createEmptySession({});
		const host = await manager.openHost({
			autoContinue: false,
			capabilities: services.capabilities,
			sessionId,
			view: true,
		});
		const controller = host.providerController;
		if (controller === undefined) {
			throw new Error("The Session Host did not create a Provider controller.");
		}

		expect(runtime.getProviderRegistrations(sessionId)).toEqual([]);
		expect(
			controller
				.getConnectableProviders()
				.map(({ providerId: id }) => id)
				.filter((id) => id === providerId)
		).toEqual([]);
		await expect(
			controller.connectPluginProvider(
				providerId,
				async () => "unused fake input"
			)
		).rejects.toThrow("Plugin Provider connection is unavailable.");
		expect(providerFactoryCalls).toBe(0);
		expect(connectCalls).toBe(0);

		await manager.withIdleForReload(async () => {
			await manager.replacePluginRuntime(runtime, { trustChanged: true });
		});
		expect(
			controller
				.getConnectableProviders()
				.map(({ providerId: id }) => id)
				.filter((id) => id === providerId)
		).toEqual([]);
		expect(providerFactoryCalls).toBe(0);
	} finally {
		await services?.shutdown();
		await manager.shutdownAll();
		await runtime.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	}
});
