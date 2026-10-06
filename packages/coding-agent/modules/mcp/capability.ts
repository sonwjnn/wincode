import type { AgentId } from "@wincode/agent-core";
import type {
	McpAgentDecisionResolver,
	McpCatalogSnapshot,
	McpRegistry,
	McpToolExecutor,
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
	releaseSnapshot?: (snapshot: McpCatalogSnapshot) => void;
}>;

/** Lifecycle wrapper for the MCP registry owned by the built-in Plugin. */
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
	execute: (snapshot, toolName, input, signal) =>
		registry.execute(snapshot, toolName, input, signal),
	releaseSnapshot: (snapshot) => registry.releaseSnapshot?.(snapshot),
});
