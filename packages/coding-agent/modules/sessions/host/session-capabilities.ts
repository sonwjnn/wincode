import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import type { AgentRuntime } from "@wincode/agent-core";
import { type Connections, createConnections } from "@wincode/ai/connections";
import { logger } from "@wincode/utils";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import { resolveAgentRegistry } from "@/modules/agents/registry";
import type { McpSessionCapability } from "@/modules/mcp/capability";
import { createMcpRegistry, type McpRegistry } from "@/modules/mcp/registry";
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
import type { ConfigRuntime, ConfigStore } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import { toWorkspaceId, type WorkspaceId } from "@/shared/identifiers";
import { errorLogFields } from "@/shared/utils/error-log-fields";
import {
	createSessionCompaction,
	type SessionCompactionModule,
} from "../compaction/compaction";
import { estimateCompactionTokens } from "../compaction/config";
import { createCompactionSettingsOperations } from "../compaction/settings-operations";
import { createDirectSummaryGenerator } from "../compaction/summary-generator";
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
import type { SessionCapabilities } from "./types";

export type SessionCapabilitiesOptions = Readonly<{
	approvalMode?: "interactive" | "non-interactive";
	connections?: Connections;
	configRuntime?: ConfigRuntime;
	configStore?: ConfigStore;
	database?: SessionDatabase;
	databasePath?: string;
	mcp?: McpRegistry;
	permissionService?: PermissionService;
	pricing?: ModelPricingTable;
	registry?: AgentRegistry | null;
	runtimeFactory?: () => AgentRuntime;
	store?: SessionStore;
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

const asMcpCapability = (registry: McpRegistry): McpSessionCapability => ({
	createSnapshot: (agent, policy, trackLatest) =>
		registry.createSnapshot(agent, policy, trackLatest),
	execute: (snapshot, toolName, input, signal) =>
		registry.execute(snapshot, toolName, input, signal),
	releaseSnapshot: (snapshot) => registry.releaseSnapshot?.(snapshot),
});
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
	cwd,
	database: providedDatabase,
	databasePath,
	mcp: providedMcp,
	permissionService: providedPermissionService,
	pricing = {},
	registry: providedRegistry,
	runtimeFactory,
	store: providedStore,
	workspace,
}: SessionCapabilitiesOptions): Promise<SessionCapabilitiesAssembly> => {
	const configStore =
		providedConfigStore ??
		providedConfigRuntime?.configStore ??
		createConfigStore();
	const configRuntime: ConfigRuntime = providedConfigRuntime ?? {
		configStore,
		cwd,
		homeRoot: homedir(),
		workspace,
	};
	let ownedDatabase: OpenedSessionDatabase | undefined;
	let ownedMcp: McpRegistry | undefined;
	const closeOwnedMcp = async (
		mcp: McpRegistry,
		phase: "shutdown" | "initialization-failure"
	): Promise<void> => {
		try {
			await mcp.close();
		} catch (error) {
			void logger.warn("MCP cleanup failed", {
				...errorLogFields(error),
				operation: "session-capabilities.mcp",
				phase,
			});
		}
	};
	try {
		if (providedDatabase === undefined && providedStore === undefined) {
			ownedDatabase = await openSessionDatabase({ databasePath, workspace });
		}
		const connections = providedConnections ?? createConnections();
		const mcp = providedMcp ?? createMcpRegistry({ configStore, workspace });
		if (providedMcp === undefined) {
			ownedMcp = mcp;
		}
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
		const policyState = createToolPermissionPolicyState();
		const toolPermission: ToolPermissionRuntime = createToolPermissionRuntime({
			agent: registry?.defaultAgentId ?? DEFAULT_AGENT_ID,
			policyState,
			registry,
			service: permissionService,
			workspace,
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
		const sessionHostManager = createSessionHostManager();
		const ownsMcp = providedMcp === undefined;
		if (ownsMcp) {
			await mcp.initialize();
		}
		let shutdownPromise: Promise<void> | undefined;
		const shutdown = (): Promise<void> => {
			if (shutdownPromise !== undefined) {
				return shutdownPromise;
			}
			const closing = (async () => {
				try {
					await sessionHostManager.shutdownAll();
				} finally {
					if (ownsMcp) {
						await closeOwnedMcp(mcp, "shutdown");
					}
					ownedDatabase?.sqlite.close();
				}
			})();
			shutdownPromise = closing;
			return closing;
		};
		const capabilities: SessionCapabilities = {
			getApprovalMode: () => approvalMode ?? "interactive",
			getCompactionModule: () => compaction,
			getCompactionSettings: compactionSettings.getCompactionSettings,
			getConfig: () => configRuntime,
			getConnections: () => connections,
			getMcp: () => asMcpCapability(mcp),
			getRegistry: () => registry,
			getStore: () => store,
			getSessionHostManager: () => sessionHostManager,
			getToolPermission: () => toolPermission,
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
		if (ownedMcp !== undefined) {
			await closeOwnedMcp(ownedMcp, "initialization-failure");
		}
		ownedDatabase?.sqlite.close();
		throw error;
	}
};
