import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { type AgentTurnEvent, toModelId } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import type {
	ChatEvent,
	CredentialStore,
	ModelStore,
	Provider,
	ProviderModel,
} from "@wincode/ai/sdk";
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
import type {
	SessionSdkHandle,
	SessionSdkPrompt,
} from "@/modules/sessions/sdk-contract";
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
import { agentId } from "../support/identifiers";

const pluginSource = (
	owner: string,
	expectedApiKey: string,
	streamStartedFile?: string,
	activityFile?: string
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
          modelId: ${JSON.stringify(`${owner}-model`)},
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
	model: ProviderModelSelection
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
		const admission = await handle.prompt({ model, text });
		expect(admission?.rejected).toBe(false);
		return { output, terminal: await terminal.promise };
	} finally {
		unsubscribe?.();
	}
};

const modelFor = (modelId: string): ProviderModelSelection => ({
	modelId: toModelId(modelId),
	providerId: "shared_provider",
});

const textOfModels = (models: readonly ProviderModel[]): readonly string[] =>
	models.map(({ modelId }) => modelId);

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
			pluginSource("owner-a", "fake-key-a", streamStartedFile)
		),
		Bun.write(
			pluginBPath,
			pluginSource("owner-b", "fake-key-b", undefined, providerActivityFile)
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
	let reloadCandidate: PluginRuntime | undefined;
	let reloadTrustChanged = false;
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
		const revokedRuntime = await loadPlugins({
			cliPaths: [],
			config: configRuntime,
			distributionPlugins: [],
			userDataDir,
		});
		pluginRuntimes.push(runtimeA, runtimeB, failingRuntime, revokedRuntime);
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
		const credentialStore = createProviderSdkCredentialStore({
			platformStore: null,
			userDataDir,
		});
		const storedModelStore = createProviderSdkModelStore({ userDataDir });
		let failModelRestores = false;
		let failedSafeCompositionReads = 0;
		const modelStore: ModelStore = {
			get: (providerId) => {
				if (failModelRestores) {
					failedSafeCompositionReads += 1;
					throw new Error("fake safe-composition snapshot failure");
				}
				return storedModelStore.get(providerId);
			},
			set: (providerId, models, options) =>
				storedModelStore.set(providerId, models, options),
		};
		const resourceLoader: ApplicationResourceLoader = {
			reload: async ({ current }) => ({
				configRuntime: current.configRuntime,
				diagnostics: [],
				pluginRuntime: reloadCandidate ?? current.pluginRuntime,
				pluginRuntimeChanged:
					reloadCandidate !== undefined &&
					reloadCandidate !== current.pluginRuntime,
				trustChanged: reloadTrustChanged,
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
				connections: () =>
					fromPartial<Connections>({
						authorize: async () => {
							throw new Error("Plugin Provider turns must use the SDK.");
						},
						connect: async () => {
							throw new Error("Plugin Providers use their own interaction.");
						},
						listProviders: async () => [],
					}),
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
		const selectedA = modelFor("owner-a-model");
		const sessionId = await services.sessionSdk.createEmptySession({
			model: selectedA,
		});
		const host = await manager.openHost({
			autoContinue: false,
			capabilities: services.capabilities,
			sessionId,
			view: true,
		});
		handle = fromPartial<SessionSdkHandle>({
			onEvent: host.onEvent,
			prompt: ({ model, text }: SessionSdkPrompt) =>
				host.agentSession.prompt({
					agent: agentId("build"),
					composition: { files: [], text },
					model: model ?? selectedA,
					sessionModel: selectedA,
					userText: text,
				}),
			sessionId,
		});
		const hostCollection = hostCollections[0];
		if (hostCollection === undefined) {
			throw new Error(
				"The Session Host did not create its ProviderCollection."
			);
		}
		expect(hostCollection.getPluginProviderRegistrations()).toHaveLength(1);
		const controller = host.providerController;
		if (controller === undefined) {
			throw new Error(
				"The Session Host did not create its ProviderController."
			);
		}

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
		expect(textOfModels(ownerAConnection.models)).toEqual(["owner-a-model"]);
		const firstSend = await send(handle, "use owner A", selectedA);
		expect(firstSend.terminal).toMatchObject({ type: "agent-turn-completed" });
		expect(assistantText(host.agentSession.getSnapshot().transcript)).toContain(
			"authorized:owner-a"
		);

		// A live Provider send keeps the Host busy, so reload cannot swap its composition.
		const busyTurn = send(handle, "hold provider for reload", selectedA);
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
		expect(textOfModels(await controller.getKnownModels())).toEqual([
			"owner-a-model",
		]);
		expect(
			(await send(handle, "old owner still runs", selectedA)).terminal.type
		).toBe("agent-turn-completed");
		await waitForHostIdle(host);
		expect(toastMessage).toContain("Kept the active Plugin set");

		// A different canonical source with the same Plugin and Provider IDs cannot reuse A's data.
		reloadCandidate = runtimeB;
		reloadTrustChanged = false;
		await reloadInteractiveResources({
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: ({ message }) => (toastMessage = message) },
			lifecycle: createInteractiveRuntimeLifecycle(),
		});
		expect(getInteractiveRuntimeContext().pluginRuntime).toBe(runtimeB);
		expect(await controller.getKnownModels()).toEqual([]);
		expect(await controller.getAvailableModels()).toEqual([]);
		const selectedB = modelFor("owner-b-model");
		const ownerBConnection = await controller.connectPluginProvider(
			"shared_provider",
			async () => "fake-key-b"
		);
		if (ownerBConnection?.kind !== "connected") {
			throw new Error("The fake owner-B Provider did not connect.");
		}
		expect(textOfModels(ownerBConnection.models)).toEqual(["owner-b-model"]);
		const secondSend = await send(handle, "use owner B", selectedB);
		expect(secondSend.terminal.type).toBe("agent-turn-completed");
		await waitForHostIdle(host);
		expect(assistantText(host.agentSession.getSnapshot().transcript)).toContain(
			"authorized:owner-b"
		);

		// If safe built-in-only preparation fails, revocation must fail closed before
		// old Provider cleanup yields to later operations.
		const activityBeforeRevocation: Readonly<{
			authorization: number;
			connect: number;
			discovery: number;
			stream: number;
		}> = await Bun.file(providerActivityFile).json();
		failModelRestores = true;
		reloadCandidate = revokedRuntime;
		reloadTrustChanged = true;
		await reloadInteractiveResources({
			refreshAgentRegistry: () => undefined,
			reloadTheme: () => undefined,
			toast: { show: ({ message }) => (toastMessage = message) },
			lifecycle: createInteractiveRuntimeLifecycle(),
		});
		failModelRestores = false;
		expect(failedSafeCompositionReads).toBeGreaterThan(0);
		expect(getInteractiveRuntimeContext().pluginRuntime).toBe(revokedRuntime);
		expect(
			controller.getConnectableProviders().map(({ providerId }) => providerId)
		).toEqual([]);
		expect(hostCollection.getPluginProviderRegistrations()).toEqual([]);
		expect(
			hostCollection.getPluginProviderComposition("shared_provider")
		).toBeUndefined();
		expect(await controller.getKnownModels()).toEqual([]);
		await expect(
			controller.connectPluginProvider(
				"shared_provider",
				async () => "fake-key-b"
			)
		).rejects.toThrow("Plugin Provider connection is unavailable.");
		await expect(
			controller.refreshProviderModels("shared_provider")
		).rejects.toThrow("Unknown provider: shared_provider");
		const revokedChatEvents: ChatEvent[] = [];
		for await (const event of hostCollection.chat({
			messages: [
				{
					content: [{ text: "attempt revoked Provider", type: "text" }],
					role: "user",
				},
			],
			modelId: "owner-b-model",
			providerId: "shared_provider",
		})) {
			revokedChatEvents.push(event);
		}
		expect(revokedChatEvents.at(-1)).toMatchObject({
			outcome: {
				failure: {
					code: "provider-not-found",
					providerId: "shared_provider",
				},
				status: "failure",
			},
			type: "terminal",
		});
		expect(await Bun.file(providerActivityFile).json()).toEqual(
			activityBeforeRevocation
		);

		// Re-enabling the original canonical source can restore its quarantined owner data.
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
		expect(textOfModels(reenabledCollection.getModels())).toEqual([
			"owner-b-model",
		]);
		expect(textOfModels(await reenabledCollection.getAvailable())).toEqual([
			"owner-b-model",
		]);
		await reenabledCollection.close();
	} finally {
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
	const credentialStore: CredentialStore = {
		delete: (id) => {
			credentials.delete(id);
		},
		get: (id) => credentials.get(id),
		set: (id, credential) => {
			credentials.set(id, credential);
		},
	};
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
				connections: () =>
					fromPartial<Connections>({
						authorize: async () => null,
						connect: async () => undefined,
						listProviders: async () => [],
					}),
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
			controller.getConnectableProviders().map(({ providerId: id }) => id)
		).toEqual(["openrouter"]);
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
			controller.getConnectableProviders().map(({ providerId: id }) => id)
		).toEqual(["openrouter"]);
		expect(providerFactoryCalls).toBe(0);
	} finally {
		await services?.shutdown();
		await manager.shutdownAll();
		await runtime.shutdown();
		await fs.rm(root, { force: true, recursive: true });
	}
});
