import type { AgentId } from "@wincode/agent-core";
import {
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	type ToolResourceLimits,
} from "@wincode/coding-tools";
import type { WorkspacePolicy } from "@wincode/coding-tools/workspace";
import { createWorkspaceSandbox } from "@wincode/coding-tools/workspace";
import { useCallback, useMemo, useRef } from "react";
import { type AgentRegistry, useAgentRegistry } from "@/modules/agents";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useConfig } from "@/shared/config/config-provider";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import type {
	ToolApprovalActions,
	ToolApprovalRequest,
} from "@/shared/providers/approval/types";
import type { PermissionService } from "./permission-service";
import { usePermissionService } from "./permission-service-provider";
import type { EffectiveAgentPolicy } from "./policy";
import {
	applyManualApprovalSafetyCeiling,
	createResolvedToolPermission,
	createToolPermission,
	DEFAULT_EFFECTIVE_AGENT_POLICY,
	DEFAULT_PERMISSION_RULES,
	type ToolPermission,
} from "./policy";

type MutableRefObject<T> = { current: T };

export type ToolPermissionRuntime = {
	closeApprovals: () => void;
	openApproval: (
		request: ToolApprovalRequest,
		actions: ToolApprovalActions
	) => void;
	permissionRef: MutableRefObject<ToolPermission>;
	resolveMcpPolicy: () => Promise<EffectiveAgentPolicy>;
	resolveMcpPolicyForAgent: (agent: AgentId) => Promise<EffectiveAgentPolicy>;
	resolvePermission: () => Promise<ToolPermission>;
	resolvePermissionForAgent: (agent: AgentId) => Promise<ToolPermission>;
	resolveResourceLimits: () => Promise<ToolResourceLimits>;
	resolveResourceLimitsForAgent: (
		agent: AgentId
	) => Promise<ToolResourceLimits>;
	sandbox: WorkspacePolicy;
	service: PermissionService;
};

type ResolvedToolPermissionPolicies = {
	mcpPolicy: EffectiveAgentPolicy;
	permission: ToolPermission;
	resourceLimits: ToolResourceLimits;
};

const FAIL_CLOSED_MCP_POLICY: EffectiveAgentPolicy = {
	rules: { "*": "deny" } as EffectiveAgentPolicy["rules"],
	safety: true,
};

/** Resolves one Agent's static and MCP policies without loosening MCP on failure. */
export const resolveToolPermissionPolicies = (
	registry: AgentRegistry | null,
	agent: AgentId,
	getFallbackPermission: () => ToolPermission
): ResolvedToolPermissionPolicies => {
	// An unavailable registry fails closed: the caller's fallback permission
	// applies and no MCP tool is visible until the registry resolves.
	if (registry === null) {
		return {
			mcpPolicy: FAIL_CLOSED_MCP_POLICY,
			permission: getFallbackPermission(),
			resourceLimits: getToolResourceLimits(DEFAULT_RESOURCE_LIMIT_PROFILE),
		};
	}
	// Enforce against the Agent that actually runs: an unavailable
	// selection falls back to Build, mirroring the effective-selection
	// resolution used when the message is sent, so tool visibility and
	// policy stay consistent with the executing Agent.
	const effectiveAgent =
		registry.agents.find(
			({ id, isAvailable }) => id === agent && isAvailable
		) ?? registry.agents.find(({ id }) => id === "build");
	const rules = effectiveAgent?.permission ?? DEFAULT_PERMISSION_RULES;
	const safety = effectiveAgent?.requiresManualApproval ?? false;
	const permission = createResolvedToolPermission(rules);
	const resourceProfile =
		effectiveAgent?.resourceProfile ??
		registry.resourceProfile ??
		DEFAULT_RESOURCE_LIMIT_PROFILE;
	return {
		// MCP composition consumes the raw folded rules plus the safety flag;
		// the ceiling is applied by the registry when it composes with each
		// server's own policy, so it must not be pre-applied here.
		mcpPolicy: { rules, safety },
		permission: safety
			? applyManualApprovalSafetyCeiling(permission)
			: permission,
		resourceLimits: getToolResourceLimits(resourceProfile),
	};
};

/**
 * Composes the Tool Permission runtime for chat tool dispatch: the policy
 * evaluator seeded with defaults and refreshed from the top-level config
 * `permission` section once the ConfigStore snapshot resolves, the active
 * Agent's Tool Resource Profile, the workspace sandbox used to canonicalize
 * read resources, and the inline approval panel registry for `ask` decisions.
 */
export function useToolPermission(): ToolPermissionRuntime {
	const config = useConfig();
	const { add, resolveAll } = useApprovalPanels();
	const service = usePermissionService();
	const { agent } = usePromptConfig();
	const registry = useAgentRegistry();
	const permissionRef = useRef<ToolPermission>(createToolPermission());
	const mcpPolicyRef = useRef<EffectiveAgentPolicy>(
		DEFAULT_EFFECTIVE_AGENT_POLICY
	);
	const sandbox = useMemo(
		() => createWorkspaceSandbox(config.workspace),
		[config]
	);
	const resolvedPromise = useMemo(() => {
		const resolved = resolveToolPermissionPolicies(
			registry,
			agent,
			() => permissionRef.current
		);
		// While the registry is loading, resolution fails closed but the refs
		// keep their previous values: a transient null never loosens a
		// resolved policy.
		if (registry !== null) {
			permissionRef.current = resolved.permission;
			mcpPolicyRef.current = resolved.mcpPolicy;
		}
		return Promise.resolve(resolved);
	}, [agent, registry]);
	const resolvePermission = useCallback(
		() => resolvedPromise.then((resolved) => resolved.permission),
		[resolvedPromise]
	);
	const resolveMcpPolicy = useCallback(
		() => resolvedPromise.then((resolved) => resolved.mcpPolicy),
		[resolvedPromise]
	);
	const resolvePoliciesForAgent = useCallback(
		(targetAgent: AgentId) =>
			resolveToolPermissionPolicies(
				registry,
				targetAgent,
				() => permissionRef.current
			),
		[registry]
	);
	const resolveMcpPolicyForAgent = useCallback(
		(targetAgent: AgentId) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).mcpPolicy),
		[resolvePoliciesForAgent]
	);
	const resolvePermissionForAgent = useCallback(
		(targetAgent: AgentId) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).permission),
		[resolvePoliciesForAgent]
	);
	const resolveResourceLimitsForAgent = useCallback(
		(targetAgent: AgentId) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).resourceLimits),
		[resolvePoliciesForAgent]
	);
	const resolveResourceLimits = useCallback(
		() => resolvedPromise.then((resolved) => resolved.resourceLimits),
		[resolvedPromise]
	);

	const openApproval = useCallback(
		(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
			add(request, actions);
		},
		[add]
	);
	const closeApprovals = useCallback(() => {
		resolveAll("rejected");
	}, [resolveAll]);

	return {
		closeApprovals,
		openApproval,
		permissionRef,
		resolveMcpPolicy,
		resolveMcpPolicyForAgent,
		resolvePermission,
		resolvePermissionForAgent,
		resolveResourceLimits,
		resolveResourceLimitsForAgent,
		sandbox,
		service,
	};
}
