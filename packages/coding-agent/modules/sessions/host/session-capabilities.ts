import type { Database } from "bun:sqlite";
import type {
	CredentialStoreOptions,
	ProviderAuthCheckResult,
	ProviderCollection,
	ProviderModel,
} from "@wincode/ai";
import { logger, omitUndefined } from "@wincode/utils";
import {
	type AgentRegistry,
	applyCapabilityCeilingToAgentRegistry,
	resolveAgentRegistry,
} from "@/modules/agents/registry";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	loadUserModelsJsonProviders,
	type ModelsJsonProvider,
} from "@/modules/providers/models-json";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { toWorkspaceId, type WorkspaceId } from "@/shared/identifiers";
import {
	createSessionCompaction,
	type SessionCompactionModule,
} from "../compaction/compaction";
import { estimateCompactionTokens } from "../compaction/config";
import { createCompactionSettingsOperations } from "../compaction/settings-operations";
import { resolveTurnTools, type TurnToolResolver } from "../hooks/runtime-turn";
import type { SessionSdkPluginProviderSource } from "../plugin-provider-source";
import { createDefaultSessionProviderCollection } from "../provider-collection";
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
import { createPluginCompactionLifecycle } from "./plugin-compaction-lifecycle";
import { createSessionHostManager } from "./session-host-manager";
import type { SessionCapabilities, SessionHostManager } from "./types";

/** The Plugin runtime a Session runs on, and who closes it. */
export type SessionPluginRuntime = Readonly<{
	/** Whether the caller that passes this runtime also loaded it. */
	ownedByCaller: boolean;
	runtime: PluginRuntime;
}>;

export type SessionCapabilitiesOptions = Readonly<{
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	createProviderCollection?: (
		pluginRuntime?: PluginRuntime,
		sessionId?: string,
		allowedPluginProviderIds?: readonly string[],
		allowedPluginProviderSources?: readonly SessionSdkPluginProviderSource[]
	) => ProviderCollection | undefined | Promise<ProviderCollection | undefined>;
	database?: SessionDatabase;
	databasePath?: string;
	/** Reads the current configuration, resolved per read so a reload lands. */
	getConfig: () => ConfigRuntime;
	/**
	 * Reads the current Plugin runtime, falling back to the resolved one while
	 * the source has none: Interactive Mode replaces its process runtime on
	 * Resource Reload and may not have one yet when a Session opens.
	 */
	getPluginRuntime?: () => PluginRuntime | undefined;
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
const closeConfiguredModelProviders = async (
	configuredModelProviders: readonly ModelsJsonProvider[]
): Promise<void> => {
	await Promise.allSettled(
		configuredModelProviders.map(({ provider }) =>
			Promise.resolve().then(() => provider.close?.())
		)
	);
};

const attachConfiguredModelProviders = async (
	collection: ProviderCollection,
	configuredModelProviders: readonly ModelsJsonProvider[]
): Promise<ProviderCollection> => {
	const apiKeySourceProviderIds = new Set<string>();
	for (const configured of configuredModelProviders) {
		try {
			collection.register(configured.provider);
		} catch {
			logger.warn("Skipping conflicting models.json Provider", {
				providerId: configured.provider.id,
			});
			await closeConfiguredModelProviders([configured]);
			continue;
		}
		if (configured.hasApiKeySource) {
			apiKeySourceProviderIds.add(configured.provider.id);
		}
	}
	const getAvailable = async (
		selectedProviderId?: string
	): Promise<readonly ProviderModel[]> => {
		const available = await collection.getAvailable(selectedProviderId);
		const availableIdentities = new Set(
			available.map(({ modelId, providerId }) =>
				JSON.stringify([providerId, modelId])
			)
		);
		const configuredSourceModels = collection
			.getModels()
			.filter(
				({ modelId, providerId }) =>
					apiKeySourceProviderIds.has(providerId) &&
					(selectedProviderId === undefined ||
						providerId === selectedProviderId) &&
					!availableIdentities.has(JSON.stringify([providerId, modelId]))
			);
		return [...available, ...configuredSourceModels];
	};
	const getConfiguredProviderIds = async (): Promise<readonly string[]> => [
		...new Set([
			...(await collection.getConfiguredProviderIds()),
			...apiKeySourceProviderIds,
		]),
	];
	const checkAuth = async (
		providerId: string,
		options?: CredentialStoreOptions
	): Promise<ProviderAuthCheckResult> => {
		const result = await collection.checkAuth(providerId, options);
		return result.status === "missing" &&
			apiKeySourceProviderIds.has(providerId)
			? { source: "stored-credential", status: "configured" }
			: result;
	};
	return Object.freeze({
		...collection,
		checkAuth,
		getAvailable,
		getConfiguredProviderIds,
	});
};

export const createSessionCapabilities = async ({
	getConfig: providedGetConfig,
	createProviderCollection: providedProviderCollectionFactory,
	capabilityCeiling,
	database: providedDatabase,
	databasePath,
	getRegistry: providedGetRegistry,
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
	const providerCollectionFactory: NonNullable<
		SessionCapabilitiesOptions["createProviderCollection"]
	> = async (
		collectionPluginRuntime,
		sessionId,
		allowedPluginProviderIds,
		allowedPluginProviderSources
	) => {
		const runtime = readConfigRuntime();
		const configuredModelProviders = await loadUserModelsJsonProviders(
			runtime.configStore,
			runtime.workspace,
			omitUndefined({ sessionId })
		);
		if (providedProviderCollectionFactory === undefined) {
			return createDefaultSessionProviderCollection(
				collectionPluginRuntime,
				sessionId,
				{
					...(allowedPluginProviderIds === undefined
						? {}
						: { allowedPluginProviderIds }),
					...(allowedPluginProviderSources === undefined
						? {}
						: { allowedPluginProviderSources }),
					configuredModelProviders,
				}
			);
		}
		let collection: ProviderCollection | undefined;
		try {
			collection = await providedProviderCollectionFactory(
				collectionPluginRuntime,
				sessionId,
				allowedPluginProviderIds,
				allowedPluginProviderSources
			);
		} catch (error) {
			await closeConfiguredModelProviders(configuredModelProviders);
			throw error;
		}
		if (collection === undefined) {
			await closeConfiguredModelProviders(configuredModelProviders);
			return;
		}
		return attachConfiguredModelProviders(collection, configuredModelProviders);
	};
	let ownedDatabase: OpenedSessionDatabase | undefined;
	try {
		if (providedDatabase === undefined && providedStore === undefined) {
			ownedDatabase = await openSessionDatabase({ databasePath, workspace });
		}
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
			});
			return () => registry;
		};
		const getRegistry = await resolveRegistry();
		const getPluginRuntime = (): PluginRuntime =>
			providedGetPluginRuntime?.() ?? pluginRuntime;
		const pluginCompactionLifecycle = createPluginCompactionLifecycle({
			getRuntime: getPluginRuntime,
			workspace,
		});
		const compaction: SessionCompactionModule = createSessionCompaction({
			attachmentStore: store.attachmentStore,
			estimateTokens: estimateCompactionTokens,
			lifecycle: pluginCompactionLifecycle,
			store,
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
		const capabilities: SessionCapabilities = {
			createProviderCollection: providerCollectionFactory,
			getCapabilityCeiling: () => capabilityCeiling,
			getCompactionModule: () => compaction,
			getCompactionSettings: (
				model: ProviderModelSelection,
				providerModel?: ProviderModel | null
			) =>
				createCompactionSettingsOperations({
					// A Resource Reload that swaps the ConfigStore lands on the next read.
					configStore: providedGetConfig().configStore,
					workspace,
				}).getCompactionSettings(model, providerModel),
			getConfig: readConfigRuntime,
			getRegistry,
			getStore: () => store,
			getSessionHostManager: () => sessionHostManager,
			...(getSessionSdk === undefined ? {} : { getSessionSdk }),
			getPluginRuntime,
			getTurnToolResolver: () => turnToolResolver ?? resolveTurnTools,
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
