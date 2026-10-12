import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "@wincode/agent-core";
import { type Connections, createConnections } from "@wincode/ai/connections";
import {
	type AgentRegistry,
	applyCapabilityCeilingToAgentRegistry,
	resolveAgentRegistry,
} from "@/modules/agents/registry";
import type { ModelPricingTable } from "@/modules/model-pricing/model-pricing";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { toWorkspaceId, type WorkspaceId } from "@/shared/identifiers";
import {
	createSessionCompaction,
	type SessionCompactionModule,
} from "../compaction/compaction";
import { estimateCompactionTokens } from "../compaction/config";
import { createCompactionSettingsOperations } from "../compaction/settings-operations";
import { createDirectSummaryGenerator } from "../compaction/summary-generator";
import { resolveTurnTools, type TurnToolResolver } from "../hooks/runtime-turn";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkOperations,
} from "../sdk-contract";
import {
	createDatabase,
	type SessionDatabase,
	SessionDatabaseResetRequiredError,
} from "../storage/client";
import {
	createDrizzleSessionStore,
	type DrizzleSessionStoreOptions,
} from "../storage/drizzle-session-store";
import {
	resolveLocalAttachmentRoot,
	resolveLocalDatabasePath,
	resolveLocalSnapshotRoot,
	resolveSessionDatabasePath,
} from "../storage/path";
import { resetLocalSessionData } from "../storage/reset-local-session-data";
import type { SessionStore } from "../storage/session-store";
import { createSessionHostManager } from "./session-host-manager";
import type { SessionCapabilities, SessionHostManager } from "./types";

/** The table compaction settings resolve against when a caller supplies none. */
const EMPTY_MODEL_PRICING: ModelPricingTable = Object.freeze({});

/**
 * The Connections a capability reads: the caller's source when it has one,
 * otherwise one Connections this process resolves on first read, so every
 * capability in one assembly reads the same instance.
 */
export const resolveConnectionsSource = (
	live?: () => Connections
): (() => Connections) => {
	if (live !== undefined) {
		return live;
	}
	let fallback: Connections | undefined;
	return () => {
		fallback ??= createConnections();
		return fallback;
	};
};

/** The Plugin runtime a Session runs on, and who closes it. */
export type SessionPluginRuntime = Readonly<{
	/** Whether the caller that passes this runtime also loaded it. */
	ownedByCaller: boolean;
	runtime: PluginRuntime;
}>;

export type SessionCapabilitiesOptions = Readonly<{
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	database?: SessionDatabase;
	databasePath?: string;
	/** Reads the current configuration, resolved per read so a reload lands. */
	getConfig: () => ConfigRuntime;
	/** Reads the current Connections, resolved per read. */
	getConnections?: () => Connections;
	/**
	 * Reads the current Plugin runtime, falling back to the resolved one while
	 * the source has none: Interactive Mode replaces its process runtime on
	 * Resource Reload and may not have one yet when a Session opens.
	 */
	getPluginRuntime?: () => PluginRuntime | undefined;
	/** Reads the current Model Catalog pricing, resolved per read. */
	getPricing?: () => ModelPricingTable;
	/** Reads the current Agent registry, resolved per read. */
	getRegistry?: () => AgentRegistry | null;
	/** Reads the Plugin-facing Session SDK operations while the Session is open. */
	getSessionSdk?: () => SessionSdkOperations | undefined;
	/**
	 * The Plugin runtime this Session runs on. A borrowed runtime stays its
	 * loader's to close, so a Session-scoped teardown never stops Plugins
	 * another Session still uses.
	 */
	plugin: SessionPluginRuntime;
	runtimeFactory?: () => AgentRuntime;
	sessionHostManager?: SessionHostManager;
	store?: SessionStore;
	turnToolResolver?: TurnToolResolver;
	workspace: string;
}>;

export type SessionCapabilitiesAssembly = Readonly<{
	capabilities: SessionCapabilities;
	/**
	 * Reads the current Plugin runtime, exactly as the capabilities do, so the
	 * precedence between a caller's source and the resolved runtime lives here
	 * once. It is exposed because it is total: the capability's accessor is
	 * optional — a Session Host Manager falls back to its own process runtime
	 * for a hand-built capabilities object — while an assembly always has a
	 * runtime for Session Services to wait on.
	 */
	getPluginRuntime: () => PluginRuntime;
	shutdown: () => Promise<void>;
	store: SessionStore;
	workspace: string;
	workspaceId: WorkspaceId;
}>;

const workspaceIdentity = (workspace: string): WorkspaceId =>
	toWorkspaceId(
		new Bun.CryptoHasher("sha256").update(workspace).digest("hex").slice(0, 16)
	);

const sessionHostManagerFor = (
	provided: SessionHostManager | undefined,
	pluginRuntime: PluginRuntime
): SessionHostManager => provided ?? createSessionHostManager(pluginRuntime);

type OpenSessionDatabaseInput = Readonly<{
	databasePath?: string;
	workspace: string;
}>;

type OpenedSessionDatabase = {
	db: SessionDatabase;
	sqlite: Database;
};

const openSessionDatabase = async ({
	databasePath,
	workspace,
}: OpenSessionDatabaseInput): Promise<OpenedSessionDatabase> => {
	const localDatabasePath = resolveSessionDatabasePath(
		databasePath ?? resolveLocalDatabasePath()
	);
	try {
		return createDatabase(localDatabasePath);
	} catch (error) {
		if (!(error instanceof SessionDatabaseResetRequiredError)) {
			throw error;
		}
		await resetLocalSessionData({
			attachmentRoot: resolveLocalAttachmentRoot(localDatabasePath),
			databasePath: localDatabasePath,
			snapshotRoot: resolveLocalSnapshotRoot(localDatabasePath),
			workspaceRoot: workspace,
		});
		return createDatabase(localDatabasePath);
	}
};

/**
 * Composes the same React-free capability graph used by Session Host, suitable
 * for a long-lived JSONL process. Every owned resource is released together by
 * the returned shutdown function; injected resources remain caller-owned.
 */
export const createSessionCapabilities = async ({
	getConnections: providedGetConnections,
	getConfig: providedGetConfig,
	capabilityCeiling,
	database: providedDatabase,
	databasePath,
	getPricing: providedGetPricing,
	getRegistry: providedGetRegistry,
	runtimeFactory,
	store: providedStore,
	plugin,
	getPluginRuntime: providedGetPluginRuntime,
	sessionHostManager: providedSessionHostManager,
	getSessionSdk,
	turnToolResolver,
	workspace,
}: SessionCapabilitiesOptions): Promise<SessionCapabilitiesAssembly> => {
	const { ownedByCaller, runtime: pluginRuntime } = plugin;
	/** The configuration a capability reads, resolved per read so a reload lands. */
	const readConfigRuntime = providedGetConfig;
	let ownedDatabase: OpenedSessionDatabase | undefined;
	try {
		if (providedDatabase === undefined && providedStore === undefined) {
			ownedDatabase = await openSessionDatabase({ databasePath, workspace });
		}
		/** The Connections a capability reads, resolved per read. */
		const readConnections = resolveConnectionsSource(providedGetConnections);
		const database = providedDatabase ?? ownedDatabase?.db;
		const store =
			providedStore ??
			createDrizzleSessionStore(database, {
				workspaceRoot: workspace,
			} satisfies DrizzleSessionStoreOptions);
		/**
		 * The Agent registry a capability reads. A caller that supplies a source
		 * is never read at open, so its registry is only resolved per use.
		 */
		const resolveRegistry = async (): Promise<() => AgentRegistry | null> => {
			if (providedGetRegistry !== undefined) {
				return () =>
					applyCapabilityCeilingToAgentRegistry(
						providedGetRegistry(),
						capabilityCeiling
					);
			}
			const registry = await resolveAgentRegistry(readConfigRuntime(), {
				capabilityCeiling,
				pluginAgentRegistrations: pluginRuntime.getAgentRegistrations(),
				connectedProviderIds: new Set(
					(await readConnections().listProviders())
						.filter((provider) => provider.connected)
						.map((provider) => provider.id)
				),
			});
			return () => registry;
		};
		const getRegistry = await resolveRegistry();
		const pricing = (): ModelPricingTable =>
			providedGetPricing?.() ?? EMPTY_MODEL_PRICING;
		const compaction: SessionCompactionModule = createSessionCompaction({
			attachmentStore: store.attachmentStore,
			estimateTokens: estimateCompactionTokens,
			store,
			// The summary generator resolves its Model Target through the
			// Connections facade, which reads stored credentials per call, so a
			// reconnected provider reaches compaction without rebuilding the module.
			summaryGenerator: createDirectSummaryGenerator(readConnections()),
		});
		const sessionHostManager = sessionHostManagerFor(
			providedSessionHostManager,
			pluginRuntime
		);
		let shutdownPromise: Promise<void> | undefined;
		const shutdown = (): Promise<void> => {
			if (shutdownPromise !== undefined) {
				return shutdownPromise;
			}
			const closing = (async () => {
				try {
					if (providedSessionHostManager === undefined) {
						await sessionHostManager.shutdownAll();
					}
					if (ownedByCaller) {
						await pluginRuntime.shutdown();
					}
				} finally {
					ownedDatabase?.sqlite.close();
				}
			})();
			shutdownPromise = closing;
			return closing;
		};
		const getPluginRuntime = (): PluginRuntime =>
			providedGetPluginRuntime?.() ?? pluginRuntime;
		const capabilities: SessionCapabilities = {
			getCapabilityCeiling: () => capabilityCeiling,
			getCompactionModule: () => compaction,
			getCompactionSettings: (model) =>
				createCompactionSettingsOperations({
					// The store follows the configuration a capability reads, so a
					// Resource Reload that swaps it lands here too.
					configStore: providedGetConfig().configStore,
					pricing: pricing(),
					workspace,
				}).getCompactionSettings(model),
			getConfig: readConfigRuntime,
			getConnections: readConnections,
			getRegistry,
			getStore: () => store,
			getSessionHostManager: () => sessionHostManager,
			...(getSessionSdk === undefined ? {} : { getSessionSdk }),
			getPluginRuntime,
			getTurnToolResolver: () => turnToolResolver ?? resolveTurnTools,
			...(runtimeFactory === undefined ? {} : { getRuntime: runtimeFactory }),
		};
		return {
			capabilities,
			getPluginRuntime,
			shutdown,
			store,
			workspace,
			workspaceId: workspaceIdentity(workspace),
		};
	} catch (error) {
		ownedDatabase?.sqlite.close();
		throw error;
	}
};
