import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Session Services open resources of their own, so this test runs against
 * a private temporary directory and observes Plugin shutdown through the
 * fixture's own lifecycle log rather than through the services' internals.
 */
const testDirectory = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-session-services-")
);
const lifecycleLogPath = path.join(testDirectory, "plugin-lifecycle.log");
const restoreEnvironment = createEnvironmentRestorer([
	"WINCODE_TEST_PLUGIN_LIFECYCLE_LOG",
]);
process.env.WINCODE_TEST_PLUGIN_LIFECYCLE_LOG = lifecycleLogPath;

import { fromPartial } from "@total-typescript/shoehorn";
import type { ProviderModel } from "@wincode/ai";
import type { AgentRegistry } from "@/modules/agents/registry";
import { buildAgentRegistry } from "@/modules/agents/registry";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type { SessionHostManager } from "@/modules/sessions/host/types";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	type ConfigRuntime,
	type ConfigSnapshot,
	createConfigStore,
} from "@/shared/config/config-store";
import { createEnvironmentRestorer } from "../support/environment";
import { modelId } from "../support/identifiers";
import { createEmptyPluginRuntime } from "../support/plugin-runtime";
import { sessionStoreWithSuccessfulWrites } from "../support/session-write-store";

const workspace = path.join(testDirectory, "workspace");
const homeRoot = path.join(testDirectory, "home");
const pluginPath = path.resolve(
	import.meta.dir,
	"../fixtures/plugin-lifecycle.ts"
);
await Promise.all([
	fs.mkdir(workspace, { recursive: true }),
	fs.mkdir(homeRoot, { recursive: true }),
]);

const configStore = createConfigStore({ homeRoot });
const configRuntime: ConfigRuntime = {
	configStore,
	cwd: workspace,
	homeRoot,
	trustedProjectRoots: [],
	workspace,
};
/** The empty Plugin runtime the Session Services in this file borrow. */
const emptyRuntime = createEmptyPluginRuntime();

const registry: AgentRegistry = buildAgentRegistry(
	fromPartial<ConfigSnapshot>({
		diagnostics: [],
		document: {},
		sourceFor: () => undefined,
		sources: [],
	})
);
const database = createDatabase(path.join(testDirectory, "sessions.db"));
const store = sessionStoreWithSuccessfulWrites(
	createDrizzleSessionStore(database.db, { workspaceRoot: workspace })
);

const lifecycleLog = async (): Promise<string[]> => {
	const file = Bun.file(lifecycleLogPath);
	if (!(await file.exists())) {
		return [];
	}
	const text = (await file.text()).trim();
	return text.length === 0 ? [] : text.split("\n");
};

const resetLifecycleLog = async (): Promise<void> => {
	await fs.rm(lifecycleLogPath, { force: true });
};

const sources = {
	configRuntime: () => configRuntime,
	registry: () => null,
	store: () => store,
};

afterAll(async () => {
	database.sqlite.close();
	await fs.rm(testDirectory, { force: true, recursive: true });
	restoreEnvironment();
});

test("closes the Plugin runtime it loaded itself", async () => {
	await resetLifecycleLog();
	const services = await openSessionServices({
		policy: {
			cwd: workspace,
			plugins: { paths: [pluginPath] },
			workspace,
		},
		sources,
	});

	expect(await lifecycleLog()).toEqual(["start"]);
	await services.shutdown();
	expect(await lifecycleLog()).toEqual(["start", "shutdown"]);
});

test("leaves an injected Plugin runtime for its owner to close", async () => {
	await resetLifecycleLog();
	const pluginRuntime = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => pluginRuntime },
	});

	await services.shutdown();
	expect(await lifecycleLog()).toEqual(["start"]);
	await pluginRuntime.shutdown();
	expect(await lifecycleLog()).toEqual(["start", "shutdown"]);
});

test("binds a Session SDK that writes through the services' Session Store", async () => {
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => emptyRuntime },
	});

	const sessionId = await services.sessionSdk.createEmptySession();
	expect(await services.store.getSession(sessionId)).toBeDefined();
	await services.shutdown();
});

test("opens the Sessions its Session SDK creates through the services' Host Manager", async () => {
	const manager = createSessionHostManager(createEmptyPluginRuntime());
	const openedHosts: string[] = [];
	const spy: SessionHostManager = {
		...manager,
		openHost: (input) => {
			openedHosts.push(input.sessionId);
			return manager.openHost(input);
		},
	};
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: {
			...sources,
			pluginRuntime: () => emptyRuntime,
			sessionHostManager: () => spy,
		},
	});
	const sessionId = await services.sessionSdk.createEmptySession();
	const handle = await services.sessionSdk.openSession(sessionId);

	expect(openedHosts).toEqual([sessionId]);
	await handle.dispose();
	await manager.shutdownAll();
	await services.shutdown();
});

test("reads its sources when the work needs them, not when it opens", async () => {
	let currentConfig = configRuntime;
	let currentRegistry: AgentRegistry | null = null;
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: {
			...sources,
			configRuntime: () => currentConfig,
			pluginRuntime: () => emptyRuntime,
			registry: () => currentRegistry,
		},
	});

	const replacementConfig: ConfigRuntime = { ...configRuntime, cwd: homeRoot };
	currentConfig = replacementConfig;
	currentRegistry = registry;

	expect(services.capabilities.getConfig()).toBe(replacementConfig);
	expect(services.capabilities.getRegistry()).toBe(registry);
	await services.shutdown();
});

test("resolves fallback, model metadata, and explicit override through Session Services", async () => {
	const model: ProviderModelSelection = {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai",
	};
	const configured = (
		enabled: boolean,
		contextWindowTokens: number
	): ConfigRuntime => ({
		...configRuntime,
		configStore: {
			...configRuntime.configStore,
			getSnapshot: async () =>
				fromPartial<ConfigSnapshot>({
					diagnostics: [],
					document: { compaction: { enabled }, contextWindowTokens },
					sourceFor: () => undefined,
					sources: [],
				}),
		},
	});
	let currentConfig = configRuntime;
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: {
			...sources,
			configRuntime: () => currentConfig,
			pluginRuntime: () => emptyRuntime,
		},
	});

	const first = await services.capabilities.getCompactionSettings(model);
	expect(first.modelContextLimit).toBe(272_000);
	expect(first.enabled).toBe(true);

	const providerModel = fromPartial<ProviderModel>({
		limits: { contextWindowTokens: 100_000 },
		modelId: model.modelId,
		providerId: model.providerId,
	});
	const fromModelMetadata = await services.capabilities.getCompactionSettings(
		model,
		providerModel
	);
	expect(fromModelMetadata.modelContextLimit).toBe(100_000);

	currentConfig = configured(false, 200_000);
	const second = await services.capabilities.getCompactionSettings(
		model,
		providerModel
	);
	expect(second.modelContextLimit).toBe(200_000);
	expect(second.enabled).toBe(false);
	await services.shutdown();
});

test("closes once, however many callers ask", async () => {
	const services = await openSessionServices({
		policy: { cwd: workspace, plugins: { paths: [pluginPath] }, workspace },
		sources,
	});

	expect(services.shutdown()).toBe(services.shutdown());
	await services.shutdown();
});

test("waits for the Plugin work of the runtime it resolved", async () => {
	const pluginRuntime = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => pluginRuntime },
	});
	const work = Promise.withResolvers<void>();
	pluginRuntime.registerBackgroundWork("background-session", work.promise);
	let settled = false;
	const waiting = services
		.waitForBackgroundWork("background-session")
		.then(() => {
			settled = true;
		});

	await Bun.sleep(1);
	expect(settled).toBe(false);
	work.resolve();
	await waiting;
	expect(settled).toBe(true);
	await services.shutdown();
	await pluginRuntime.shutdown();
});

test("reads the current Plugin runtime, not the one it opened with", async () => {
	const first = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	const second = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	let current = first;
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => current },
	});

	expect(services.capabilities.getPluginRuntime?.()).toBe(first);
	current = second;
	expect(services.capabilities.getPluginRuntime?.()).toBe(second);
	await services.shutdown();
	await first.shutdown();
	await second.shutdown();
});

test("adopts a Plugin runtime that appears after it opened without one", async () => {
	let current: PluginRuntime | undefined;
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => current },
	});
	const appeared = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	current = appeared;

	expect(services.capabilities.getPluginRuntime?.()).toBe(appeared);
	await services.shutdown();
	await appeared.shutdown();
});

test("runs without Plugins when the caller supplies neither a runtime nor a policy", async () => {
	const services = await openSessionServices({
		policy: { cwd: workspace, workspace },
		sources: {
			configRuntime: () => configRuntime,
			store: () => store,
		},
	});

	expect(
		services.capabilities.getPluginRuntime?.()?.getToolDescriptors("no-plugins")
	).toEqual([]);
	await services.shutdown();
});

test("uses the Plugin runtime it was handed instead of loading its policy", async () => {
	await resetLifecycleLog();
	const borrowed = await loadPlugins({ cliPaths: [], config: configRuntime });
	const services = await openSessionServices({
		policy: {
			cwd: workspace,
			plugins: {
				distributionPackages: [
					{ id: "lifecycle_recorder", specifier: pluginPath },
				],
			},
			workspace,
		},
		sources: { ...sources, pluginRuntime: () => borrowed },
	});

	expect(services.capabilities.getPluginRuntime?.()).toBe(borrowed);
	expect(await lifecycleLog()).toEqual([]);
	await services.shutdown();
	await borrowed.shutdown();
});

test("skips the distribution Plugin package its policy disables", async () => {
	await resetLifecycleLog();
	const services = await openSessionServices({
		policy: {
			cwd: workspace,
			plugins: {
				disabledIdentifiers: ["lifecycle_recorder"],
				distributionPackages: [
					{ id: "lifecycle_recorder", specifier: pluginPath },
				],
			},
			workspace,
		},
		sources,
	});

	expect(await lifecycleLog()).toEqual([]);
	await services.shutdown();
	expect(await lifecycleLog()).toEqual([]);
});

test("loads the distribution Plugin packages its policy names", async () => {
	await resetLifecycleLog();
	const services = await openSessionServices({
		policy: {
			cwd: workspace,
			plugins: {
				distributionPackages: [
					{ id: "lifecycle_recorder", specifier: pluginPath },
				],
			},
			workspace,
		},
		sources,
	});

	expect(await lifecycleLog()).toEqual(["start"]);
	await services.shutdown();
	expect(await lifecycleLog()).toEqual(["start", "shutdown"]);
});
