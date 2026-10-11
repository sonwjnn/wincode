import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The Session Environment opens resources of its own, so this test runs against
 * a private temporary directory and observes Plugin shutdown through the
 * fixture's own lifecycle log rather than through the environment's internals.
 */
const testDirectory = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-session-environment-")
);
const lifecycleLogPath = path.join(testDirectory, "plugin-lifecycle.log");
const restoreEnvironment = createEnvironmentRestorer([
	"WINCODE_TEST_PLUGIN_LIFECYCLE_LOG",
]);
process.env.WINCODE_TEST_PLUGIN_LIFECYCLE_LOG = lifecycleLogPath;

import { fromPartial } from "@total-typescript/shoehorn";
import type { Connections } from "@wincode/ai/connections";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { AgentRegistry } from "@/modules/agents/registry";
import { buildAgentRegistry } from "@/modules/agents/registry";
import type { ModelPricingTable } from "@/modules/model-pricing/model-pricing";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { openSessionEnvironment } from "@/modules/sessions/host/session-environment";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
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
const connections: Connections = {
	authorize: async () => ({
		apiKey: "session-environment-key",
		kind: "api-key",
	}),
	connect: async () => undefined,
	listProviders: async () => [],
};
/** The empty Plugin runtime the environments in this file borrow. */
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
const store = createDrizzleSessionStore(database.db, {
	workspaceRoot: workspace,
});

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
	connections: () => connections,
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
	const environment = await openSessionEnvironment({
		policy: {
			cwd: workspace,
			plugins: { paths: [pluginPath] },
			workspace,
		},
		sources,
	});

	expect(await lifecycleLog()).toEqual(["start"]);
	await environment.shutdown();
	expect(await lifecycleLog()).toEqual(["start", "shutdown"]);
});

test("leaves an injected Plugin runtime for its owner to close", async () => {
	await resetLifecycleLog();
	const pluginRuntime = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => pluginRuntime },
	});

	await environment.shutdown();
	expect(await lifecycleLog()).toEqual(["start"]);
	await pluginRuntime.shutdown();
	expect(await lifecycleLog()).toEqual(["start", "shutdown"]);
});

test("binds a Session SDK that writes through the environment's Session Store", async () => {
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => emptyRuntime },
	});

	const sessionId = await environment.sessionSdk.createEmptySession();
	expect(await environment.store.getSession(sessionId)).toBeDefined();
	await environment.shutdown();
});

test("opens the Sessions its Session SDK creates through the environment's Host Manager", async () => {
	const manager = createSessionHostManager(createEmptyPluginRuntime());
	const openedHosts: string[] = [];
	const spy: SessionHostManager = {
		...manager,
		openHost: (input) => {
			openedHosts.push(input.sessionId);
			return manager.openHost(input);
		},
	};
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: {
			...sources,
			pluginRuntime: () => emptyRuntime,
			sessionHostManager: () => spy,
		},
	});
	const sessionId = await environment.sessionSdk.createEmptySession();
	const handle = await environment.sessionSdk.openSession(sessionId);

	expect(openedHosts).toEqual([sessionId]);
	await handle.dispose();
	await manager.shutdownAll();
	await environment.shutdown();
});

test("reads its sources when the work needs them, not when it opens", async () => {
	let currentConnections = connections;
	let currentConfig = configRuntime;
	let currentRegistry: AgentRegistry | null = null;
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: {
			...sources,
			configRuntime: () => currentConfig,
			connections: () => currentConnections,
			pluginRuntime: () => emptyRuntime,
			registry: () => currentRegistry,
		},
	});

	const replacementConnections: Connections = {
		...connections,
		listProviders: async () => [],
	};
	const replacementConfig: ConfigRuntime = { ...configRuntime, cwd: homeRoot };
	currentConnections = replacementConnections;
	currentConfig = replacementConfig;
	currentRegistry = registry;

	expect(environment.capabilities.getConnections()).toBe(
		replacementConnections
	);
	expect(environment.capabilities.getConfig()).toBe(replacementConfig);
	expect(environment.capabilities.getRegistry()).toBe(registry);
	await environment.shutdown();
});

test("resolves compaction settings through the current pricing and configuration", async () => {
	const model: ChatModelSelection = {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai",
	};
	const priced = (context: number): ModelPricingTable => ({
		"openai/gpt-5.6-luna": { limits: { context } },
	});
	const configured = (enabled: boolean): ConfigRuntime => ({
		...configRuntime,
		configStore: {
			...configRuntime.configStore,
			getSnapshot: async () =>
				fromPartial<ConfigSnapshot>({
					diagnostics: [],
					document: { compaction: { enabled } },
					sourceFor: () => undefined,
					sources: [],
				}),
		},
	});
	let currentPricing = priced(100_000);
	let currentConfig = configRuntime;
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: {
			...sources,
			configRuntime: () => currentConfig,
			pluginRuntime: () => emptyRuntime,
			pricing: () => currentPricing,
		},
	});

	const first = await environment.capabilities.getCompactionSettings(model);
	expect(first.modelContextLimit).toBe(100_000);
	expect(first.enabled).toBe(true);

	currentPricing = priced(200_000);
	currentConfig = configured(false);
	const second = await environment.capabilities.getCompactionSettings(model);
	expect(second.modelContextLimit).toBe(200_000);
	expect(second.enabled).toBe(false);
	await environment.shutdown();
});

test("closes once, however many callers ask", async () => {
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, plugins: { paths: [pluginPath] }, workspace },
		sources,
	});

	expect(environment.shutdown()).toBe(environment.shutdown());
	await environment.shutdown();
});

test("waits for the Plugin work of the runtime it resolved", async () => {
	const pluginRuntime = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => pluginRuntime },
	});
	const work = Promise.withResolvers<void>();
	pluginRuntime.registerBackgroundWork("background-session", work.promise);
	let settled = false;
	const waiting = environment
		.waitForBackgroundWork("background-session")
		.then(() => {
			settled = true;
		});

	await Bun.sleep(1);
	expect(settled).toBe(false);
	work.resolve();
	await waiting;
	expect(settled).toBe(true);
	await environment.shutdown();
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
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => current },
	});

	expect(environment.capabilities.getPluginRuntime?.()).toBe(first);
	current = second;
	expect(environment.capabilities.getPluginRuntime?.()).toBe(second);
	await environment.shutdown();
	await first.shutdown();
	await second.shutdown();
});

test("adopts a Plugin runtime that appears after it opened without one", async () => {
	let current: PluginRuntime | undefined;
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: { ...sources, pluginRuntime: () => current },
	});
	const appeared = await loadPlugins({
		cliPaths: [pluginPath],
		config: configRuntime,
	});
	current = appeared;

	expect(environment.capabilities.getPluginRuntime?.()).toBe(appeared);
	await environment.shutdown();
	await appeared.shutdown();
});

test("runs without Plugins when the caller supplies neither a runtime nor a policy", async () => {
	const environment = await openSessionEnvironment({
		policy: { cwd: workspace, workspace },
		sources: {
			configRuntime: () => configRuntime,
			connections: () => connections,
			store: () => store,
		},
	});

	expect(
		environment.capabilities
			.getPluginRuntime?.()
			?.getToolDescriptors("no-plugins")
	).toEqual([]);
	await environment.shutdown();
});

test("uses the Plugin runtime it was handed instead of loading its policy", async () => {
	await resetLifecycleLog();
	const borrowed = await loadPlugins({ cliPaths: [], config: configRuntime });
	const environment = await openSessionEnvironment({
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

	expect(environment.capabilities.getPluginRuntime?.()).toBe(borrowed);
	expect(await lifecycleLog()).toEqual([]);
	await environment.shutdown();
	await borrowed.shutdown();
});

test("skips the distribution Plugin package its policy disables", async () => {
	await resetLifecycleLog();
	const environment = await openSessionEnvironment({
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
	await environment.shutdown();
	expect(await lifecycleLog()).toEqual([]);
});

test("loads the distribution Plugin packages its policy names", async () => {
	await resetLifecycleLog();
	const environment = await openSessionEnvironment({
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
	await environment.shutdown();
	expect(await lifecycleLog()).toEqual(["start", "shutdown"]);
});
