import type { AgentId } from "@wincode/agent-core";
import {
	createMcpToolExecutor,
	type McpAgentDecisionResolver,
	type McpCatalogSnapshot,
	type McpRegistry,
	type McpToolCallExecutor,
	type McpToolExecutor,
	toMcpSnapshotId,
} from "@wincode/mcp";
import {
	DEFAULT_EFFECTIVE_AGENT_POLICY,
	decideOpenActionPermission,
	type EffectiveAgentPolicy,
} from "@/modules/permissions/policy";

export type McpAgentPolicy = EffectiveAgentPolicy;
export const MCP_PERMISSION_RESOURCE = "*";

export type McpSessionCapability = Readonly<{
	createSnapshot: (
		agent: AgentId,
		agentPolicy?: McpAgentPolicy,
		trackLatest?: boolean
	) => Promise<McpCatalogSnapshot>;
	execute?: McpToolExecutor;
	executeToolCall?: McpToolCallExecutor;
	releaseSnapshot?: (snapshot: McpCatalogSnapshot) => void;
}>;

/** Lifecycle wrapper for the registry resource owned by the bundled MCP Plugin. */
export type McpPluginResource = Readonly<{
	capability: McpSessionCapability;
	close(): Promise<void>;
	initialize(): Promise<void>;
	registry: McpRegistry;
}>;

export const createMcpAgentDecisionResolver =
	(
		policy: McpAgentPolicy = DEFAULT_EFFECTIVE_AGENT_POLICY
	): McpAgentDecisionResolver =>
	({ logicalName }) => ({
		decision: decideOpenActionPermission(
			policy.rules,
			logicalName,
			MCP_PERMISSION_RESOURCE
		),
		safety: policy.safety,
	});

export const createMcpSessionCapability = (
	registry: McpRegistry
): McpSessionCapability => ({
	createSnapshot: (agent, policy, trackLatest) =>
		registry.createSnapshot(
			agent,
			createMcpAgentDecisionResolver(policy),
			trackLatest
		),
	execute: registry.execute,
	executeToolCall: createMcpToolExecutor(registry.execute),
	releaseSnapshot: (snapshot) => registry.releaseSnapshot?.(snapshot),
});

/** Supplies the neutral empty resource used when the application disables MCP. */
export const createDisabledMcpPluginResource = (): McpPluginResource => {
	const registry: McpRegistry = {
		close: async () => undefined,
		initialize: async () => undefined,
		createSnapshot: async (agent) => ({
			agent,
			id: toMcpSnapshotId(crypto.randomUUID()),
			manifest: [],
			tools: new Map(),
		}),
		execute: async () => ({
			content: [],
			isError: true,
			owner: "registry",
			truncated: false,
		}),
		getStatuses: () => [],
		reconnect: async () => undefined,
		subscribe: () => () => undefined,
		toggle: async () => undefined,
	};
	return Object.freeze({
		capability: Object.freeze(createMcpSessionCapability(registry)),
		close: () => registry.close(),
		initialize: () => registry.initialize(),
		registry,
	});
};
