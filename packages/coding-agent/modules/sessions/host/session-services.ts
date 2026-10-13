import * as os from "node:os";
import type { AgentRuntime } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import type { ProviderCollection } from "@wincode/ai/sdk";
import { omitUndefined } from "@wincode/utils";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { ModelPricingTable } from "@/modules/model-pricing/model-pricing";
import {
	loadPlugins,
	type PluginPackageReference,
} from "@/modules/plugins/loader";
import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import type { WorkspaceId } from "@/shared/identifiers";
import type { TurnToolResolver } from "../hooks/runtime-turn";
import {
	createSessionSdkOperations,
	type SessionSdkRuntimeOptions,
} from "../sdk";
import type { SessionSdkOperations } from "../sdk-contract";
import type { SessionStore } from "../storage/session-store";
import {
	createSessionCapabilities,
	resolveConnectionsSource,
	type SessionCapabilitiesAssembly,
	type SessionPluginRuntime,
} from "./session-capabilities";
import type { SessionCapabilities, SessionHostManager } from "./types";

/**
 * What opening the Session Services loads when the caller supplies no Plugin runtime.
 * Omitting it runs without Plugins rather than loading configured ones.
 */
export type SessionPluginPolicy = Readonly<{
	/** Plugin files this invocation explicitly enables. */
	paths?: readonly string[];
	/** Distributed Plugin Identifiers this invocation disables. */
	disabledIdentifiers?: readonly string[];
	/** The distribution's default Plugin packages. */
	distributionPackages?: readonly PluginPackageReference[];
}>;

/** What the caller asks opening the Session Services to create. */
export type SessionServicesPolicy = Readonly<{
	cwd: string;
	/** The local database path, when these Session Services own their storage. */
	databasePath?: string;
	plugins?: SessionPluginPolicy;
	workspace: string;
}>;

/**
 * What the caller already owns. The sources a Session's later work must see
 * current — configuration, Connections, Model Catalog pricing, and the Plugin
 * runtime Interactive Mode replaces on Resource Reload — are read when that
 * work runs, because a Session outlives the render, reload, or reconnect that
 * supplied them. The Session Store, Session Host Manager, and turn tool
 * resolver are process-scoped and resolved once at open; the Agent Runtime
 * factory is forwarded, so it is read when a turn needs one; and the Agent
 * registry is resolved once at open when the caller supplies no source, read
 * per use when it does.
 */
export type SessionServicesSources = Readonly<{
	configRuntime?: () => ConfigRuntime;
	connections?: () => Connections;
	registry?: () => AgentRegistry | null;
	store?: () => SessionStore;
	sessionHostManager?: () => SessionHostManager;
	/** Reads the current Plugin runtime; undefined while the caller has none yet. */
	pluginRuntime?: () => PluginRuntime | undefined;
	/** Creates a fresh per-Host ProviderCollection in the owning execution mode. */
	createProviderCollection?: (
		pluginRuntime?: PluginRuntime,
		sessionId?: string
	) => ProviderCollection | undefined | Promise<ProviderCollection | undefined>;
	/** Reads the current Model Catalog pricing; the compaction settings read it. */
	pricing?: () => ModelPricingTable;
	runtimeFactory?: () => AgentRuntime;
	turnToolResolver?: () => TurnToolResolver;
}>;

/**
 * One mode's, process's, or view's Session Services: what its Session Hosts run
 * on. They close only the resources they created — the Plugin runtime they
 * loaded, the database they opened, and the Session Host Manager they created —
 * so a borrowed Plugin runtime survives a Session-scoped shutdown.
 */
export type SessionServices = Readonly<{
	capabilities: SessionCapabilities;
	sessionSdk: SessionSdkOperations;
	store: SessionStore;
	/** Waits for the Plugin work one Session still owes, as Print Mode must. */
	waitForBackgroundWork: (sessionId: string) => Promise<void>;
	workspace: string;
	workspaceId: WorkspaceId;
	shutdown: () => Promise<void>;
}>;

export type SessionServicesInput = Readonly<{
	policy: SessionServicesPolicy;
	sources?: SessionServicesSources;
}>;

/**
 * Resolves the Plugin runtime these Session Services run on: the one the caller
 * already holds, one loaded from the invocation's Plugin policy, or none at
 * all. Only a runtime the factory loaded or created is these services' to close.
 */
const resolvePluginRuntime = async (
	policy: SessionServicesPolicy,
	sources: SessionServicesSources,
	configRuntime: ConfigRuntime
): Promise<SessionPluginRuntime> => {
	const borrowed = sources.pluginRuntime?.();
	if (borrowed !== undefined) {
		return { ownedByCaller: false, runtime: borrowed };
	}
	const pluginPolicy = policy.plugins;
	if (pluginPolicy === undefined) {
		// Session Services with no Plugin runtime and no Plugin policy run
		// without Plugins: a plain-Node host may want none, and the Interactive
		// adapter lends a process-scoped stand-in rather than reaching this.
		return { ownedByCaller: true, runtime: createPluginRuntime([], []) };
	}
	const runtime = await loadPlugins({
		cliPaths: pluginPolicy.paths ?? [],
		config: configRuntime,
		disabledPluginIds: pluginPolicy.disabledIdentifiers ?? [],
		distributionPlugins: pluginPolicy.distributionPackages ?? [],
	});
	return { ownedByCaller: true, runtime };
};

/**
 * Opens the Session Services every Execution Mode and the Session SDK run
 * their Session Hosts on: the Plugin runtime, durable Session storage, the
 * Session Host Manager, the Session Capabilities a Host reads lazily, and the
 * Session SDK bound to them.
 *
 * This is the only place the capability graph is assembled for a mode or a
 * process, and the only place its mutual reference with the Session SDK is
 * resolved. The Session SDK keeps a second, structural one where its own object
 * and its capabilities are mutually recursive within a single function.
 */
export const openSessionServices = async ({
	policy,
	sources = {},
}: SessionServicesInput): Promise<SessionServices> => {
	const { cwd, workspace } = policy;
	const providedConfigRuntime = sources.configRuntime?.();
	const configStore = providedConfigRuntime?.configStore ?? createConfigStore();
	const configRuntime: ConfigRuntime = providedConfigRuntime ?? {
		configStore,
		cwd,
		homeRoot: os.homedir(),
		workspace,
	};
	/**
	 * The configuration the capabilities read: the caller's source when it has
	 * one, otherwise the value the factory resolved.
	 */
	const getConfig = (): ConfigRuntime =>
		sources.configRuntime?.() ?? configRuntime;
	/**
	 * The Connections the capabilities read, shared with the Session SDK so a
	 * child Session's capabilities read the same instance. A child runtime
	 * resolves its own configuration and Project trust, which the SDK owns.
	 */
	const getConnections = resolveConnectionsSource(sources.connections);
	const plugin = await resolvePluginRuntime(policy, sources, configRuntime);
	/**
	 * The Session SDK operations and the capabilities reference each other: the
	 * capability that hands Plugin Tools their SDK needs the operations, and the
	 * operations need the Session Store and Host Manager the capabilities own.
	 * One deferred reference resolves it, here, instead of in every caller.
	 */
	let sessionSdk: SessionSdkOperations | undefined;
	/**
	 * A runtime the factory loaded is these services' to close even when opening
	 * fails, so a composing host that supplied none cannot leak one.
	 */
	const closeOwnedRuntime = async (): Promise<void> => {
		if (plugin.ownedByCaller) {
			await plugin.runtime.shutdown().catch(() => undefined);
		}
	};
	let created: SessionCapabilitiesAssembly | undefined;
	try {
		created = await createSessionCapabilities({
			...omitUndefined({ databasePath: policy.databasePath }),
			plugin,
			getSessionSdk: () => sessionSdk,
			...omitUndefined({
				getConfig,
				getConnections,
				getPluginRuntime: sources.pluginRuntime,
				createProviderCollection: sources.createProviderCollection,
				getPricing: sources.pricing,
				getRegistry: sources.registry,
				runtimeFactory: sources.runtimeFactory,
				sessionHostManager: sources.sessionHostManager?.(),
				store: sources.store?.(),
				turnToolResolver: sources.turnToolResolver?.(),
			}),
			workspace,
		});
		const assembly = created;
		const { capabilities } = assembly;
		sessionSdk = createSessionSdkOperations(
			{
				cwd,
				getConnections,
				getRegistry: () => capabilities.getRegistry(),
				store: assembly.store,
				...omitUndefined({
					createProviderCollection: sources.createProviderCollection,
					runtimeFactory: capabilities.getRuntime,
					turnToolResolver: capabilities.getTurnToolResolver?.(),
				}),
				workspace,
			} satisfies SessionSdkRuntimeOptions,
			capabilities.getSessionHostManager(),
			assembly.store
		);
		return Object.freeze({
			capabilities,
			sessionSdk,
			store: assembly.store,
			waitForBackgroundWork: (sessionId) =>
				assembly.getPluginRuntime().waitForBackgroundWork(sessionId),
			workspace,
			workspaceId: assembly.workspaceId,
			shutdown: () => assembly.shutdown(),
		});
	} catch (error) {
		// An assembly that exists owns everything these services created, so it
		// releases them; before that, only the runtime the factory loaded is these
		// services' to close.
		await created?.shutdown().catch(() => undefined);
		if (created === undefined) {
			await closeOwnedRuntime();
		}
		throw error;
	}
};
