import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import { resolveAgentRegistry } from "@/modules/agents/registry";
import type { Connections } from "@/modules/connections/contract";
import { createConnections } from "@/modules/connections/facade";
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
import {
	createSessionCompaction,
	type SessionCompactionModule,
} from "../compaction/compaction";
import { estimateCompactionTokens } from "../compaction/config";
import { createCompactionSettingsOperations } from "../compaction/settings-operations";
import { createDirectSummaryGenerator } from "../compaction/summary-generator";
import { createDatabase, type SessionDatabase } from "../storage/client";
import {
	createDrizzleSessionStore,
	type DrizzleSessionStoreOptions,
} from "../storage/drizzle-session-store";
import type { SessionStore } from "../storage/session-store";
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
		createHash("sha256").update(workspace).digest("hex").slice(0, 16)
	);

const asMcpCapability = (registry: McpRegistry): McpSessionCapability => ({
	createSnapshot: (agent, policy, trackLatest) =>
		registry.createSnapshot(agent, policy, trackLatest),
	execute: (snapshot, toolName, input, signal) =>
		registry.execute(snapshot, toolName, input, signal),
	releaseSnapshot: (snapshot) => registry.releaseSnapshot?.(snapshot),
});

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
	const ownedDatabase =
		providedDatabase === undefined && providedStore === undefined
			? createDatabase(databasePath)
			: undefined;
	let ownedMcp: McpRegistry | undefined;
	try {
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
		const ownsMcp = providedMcp === undefined;
		if (ownsMcp) {
			await mcp.initialize();
		}
		let isShutdown = false;
		const shutdown = async (): Promise<void> => {
			if (isShutdown) {
				return;
			}
			isShutdown = true;
			if (ownsMcp) {
				await mcp.close().catch(() => undefined);
			}
			ownedDatabase?.sqlite.close();
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
			getToolPermission: () => toolPermission,
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
			await ownedMcp.close().catch(() => undefined);
		}
		ownedDatabase?.sqlite.close();
		throw error;
	}
};
