import type { AgentId } from "@wincode/agent-core";
import type { McpCatalogSnapshot, McpRegistry } from "@wincode/mcp";
import {
	createMcpAgentDecisionResolver,
	type McpAgentPolicy,
} from "@/modules/mcp/capability";

export type PolicyAwareMcpRegistry = Omit<McpRegistry, "createSnapshot"> &
	Readonly<{
		createSnapshot(
			agent: AgentId,
			policy?: McpAgentPolicy,
			trackLatest?: boolean
		): Promise<McpCatalogSnapshot>;
	}>;

export const addAgentPolicyResolver = (
	registry: McpRegistry
): PolicyAwareMcpRegistry => ({
	...registry,
	createSnapshot: (agent, policy, trackLatest) =>
		registry.createSnapshot(
			agent,
			createMcpAgentDecisionResolver(policy),
			trackLatest
		),
});
