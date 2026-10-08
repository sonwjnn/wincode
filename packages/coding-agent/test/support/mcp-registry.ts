import type { AgentId } from "@wincode/agent-core";
import type {
	McpAgentDecisionResolver,
	McpCatalogSnapshot,
	McpRegistry,
} from "@wincode/mcp";
import {
	DEFAULT_EFFECTIVE_AGENT_POLICY,
	decideOpenActionPermission,
	type EffectiveAgentPolicy,
} from "@/modules/permissions/policy";

export type McpAgentPolicy = EffectiveAgentPolicy;
export type PolicyAwareMcpRegistry = Omit<McpRegistry, "createSnapshot"> &
	Readonly<{
		createSnapshot(
			agent: AgentId,
			policy?: McpAgentPolicy,
			trackLatest?: boolean
		): Promise<McpCatalogSnapshot>;
	}>;

const createAgentPolicyResolver =
	(
		policy: McpAgentPolicy = DEFAULT_EFFECTIVE_AGENT_POLICY
	): McpAgentDecisionResolver =>
	({ logicalName }) => ({
		decision: decideOpenActionPermission(policy.rules, logicalName, "*"),
		safety: policy.safety,
	});

export const addAgentPolicyResolver = (
	registry: McpRegistry
): PolicyAwareMcpRegistry => ({
	...registry,
	createSnapshot: (agent, policy, trackLatest) =>
		registry.createSnapshot(
			agent,
			createAgentPolicyResolver(policy),
			trackLatest
		),
});
