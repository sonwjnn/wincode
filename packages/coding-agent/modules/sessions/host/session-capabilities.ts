import type { Database } from "bun:sqlite";
import * as os from "node:os";
import type { AgentRuntime } from "@wincode/agent-core";
import { type Connections, createConnections } from "@wincode/ai/connections";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import { resolveAgentRegistry } from "@/modules/agents/registry";
import type { ModelPricingTable } from "@/modules/model-pricing/model-pricing";
import {
	createPermissionService,
	type PermissionService,
} from "@/modules/permissions/permission-service";
import {
	createToolPermissionPolicyState,
	createToolPermissionRuntime,
	type ToolPermissionRuntime,
} from "@/modules/permissions/tool-permission-runtime";
import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import type { ConfigRuntime, ConfigStore } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
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
	SessionSdkChildFactory,
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

export type SessionCapabilitiesOptions = Readonly<{
	approvalMode?: "interactive" | "non-interactive";
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	connections?: Connections;
	configRuntime?: ConfigRuntime;
	configStore?: ConfigStore;
	database?: SessionDatabase;
	databasePath?: string;
	permissionService?: PermissionService;
	pricing?: ModelPricingTable;
	registry?: AgentRegistry | null;
	getRegistry?: () => AgentRegistry | null;
	runtimeFactory?: () => AgentRuntime;
	store?: SessionStore;
	pluginRuntime?: PluginRuntime;
	sessionHostManager?: SessionHostManager;
	getSessionSdk?: () => SessionSdkChildFactory | undefined;
	turnToolResolver?: TurnToolResolver;
	workspace: string;
	cwd: string;
}>;

export type SessionCapabilitiesAssembly = Readonly<{
	capabilities: SessionCapabilities;
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
	approvalMode,
	connections: providedConnections,
	configRuntime: providedConfigRuntime,
	configStore: providedConfigStore,
	capabilityCeiling,
	cwd,
	database: providedDatabase,
	databasePath,
	permissionService: providedPermissionService,
	pricing = {},
	registry: providedRegistry,
	getRegistry: providedGetRegistry,
	runtimeFactory,
	store: providedStore,
	pluginRuntime: providedPluginRuntime,
	sessionHostManager: providedSessionHostManager,
	getSessionSdk,
	turnToolResolver,
	workspace,
}: SessionCapabilitiesOptions): Promise<SessionCapabilitiesAssembly> => {
	const configStore =
		providedConfigStore ??
		providedConfigRuntime?.configStore ??
		createConfigStore();
	const configRuntime: ConfigRuntime = providedConfigRuntime ?? {
		configStore,
		cwd,
		homeRoot: os.homedir(),
		workspace,
	};
	const pluginRuntime = providedPluginRuntime ?? createPluginRuntime([], []);
	let ownedDatabase: OpenedSessionDatabase | undefined;
	try {
		if (providedDatabase === undefined && providedStore === undefined) {
			ownedDatabase = await openSessionDatabase({ databasePath, workspace });
		}
		const connections = providedConnections ?? createConnections();
		const permissionService =
			providedPermissionService ?? createPermissionService();
		const database = providedDatabase ?? ownedDatabase?.db;
		const store =
			providedStore ??
			createDrizzleSessionStore(database, {
				workspaceRoot: workspace,
			} satisfies DrizzleSessionStoreOptions);
		const registry =
			providedRegistry === undefined
				? await resolveAgentRegistry(configRuntime, {
						connectedProviderIds: new Set(
							(await connections.listProviders())
								.filter((provider) => provider.connected)
								.map((provider) => provider.id)
						),
					})
				: providedRegistry;
		const getRegistry = providedGetRegistry ?? (() => registry);
		const policyState = createToolPermissionPolicyState();
		const toolPermission: ToolPermissionRuntime = createToolPermissionRuntime({
			agent: registry?.defaultAgentId ?? DEFAULT_AGENT_ID,
			policyState,
			registry,
			service: permissionService,
			workspace,
			configRuntime,
		});
		const compactionSettings = createCompactionSettingsOperations({
			configStore,
			pricing,
			workspace,
		});
		const compaction: SessionCompactionModule = createSessionCompaction({
			attachmentStore: store.attachmentStore,
			estimateTokens: estimateCompactionTokens,
			store,
			summaryGenerator: createDirectSummaryGenerator(connections),
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
					await pluginRuntime.shutdown();
				} finally {
					ownedDatabase?.sqlite.close();
				}
			})();
			shutdownPromise = closing;
			return closing;
		};
		const capabilities: SessionCapabilities = {
			getApprovalMode: () => approvalMode ?? "interactive",
			getCapabilityCeiling: () => capabilityCeiling,
			getCompactionModule: () => compaction,
			getCompactionSettings: compactionSettings.getCompactionSettings,
			getConfig: () => configRuntime,
			getConnections: () => connections,
			getRegistry,
			getStore: () => store,
			getSessionHostManager: () => sessionHostManager,
			...(getSessionSdk === undefined ? {} : { getSessionSdk }),
			getToolPermission: () => toolPermission,
			getPluginRuntime: () => pluginRuntime,
			getTurnToolResolver: () => turnToolResolver ?? resolveTurnTools,
			...(runtimeFactory === undefined ? {} : { getRuntime: runtimeFactory }),
		};
		return {
			capabilities,
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
