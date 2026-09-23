import type { AgentId } from "@wincode/agent-core";
import {
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	type ToolResourceLimits,
} from "@wincode/coding-tools";
import type { WorkspacePolicy } from "@wincode/coding-tools/workspace";
import { createWorkspaceSandbox } from "@wincode/coding-tools/workspace";
import { isNull } from "@wincode/runtime-utils";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { PermissionService } from "./permission-service";
import {
	applyManualApprovalSafetyCeiling,
	createResolvedToolPermission,
	createToolPermission,
	DEFAULT_PERMISSION_RULES,
	type EffectiveAgentPolicy,
	type ToolPermission,
} from "./policy";

export type ToolPermissionRuntime = {
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

/**
 * The permission a resolution falls back to while no Agent registry has
 * resolved. It is held by the composer rather than the runtime, so a runtime
 * recomposed for a new Agent or registry still fails back to the last resolved
 * policy instead of loosening to the default one.
 */
export type ToolPermissionPolicyState = {
	permission: ToolPermission;
};

export type ToolPermissionRuntimeDeps = {
	agent: AgentId;
	policyState: ToolPermissionPolicyState;
	registry: AgentRegistry | null;
	service: PermissionService;
	workspace: string;
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

export const createToolPermissionPolicyState =
	(): ToolPermissionPolicyState => ({
		permission: createToolPermission(),
	});

/** Resolves one Agent's static and MCP policies without loosening MCP on failure. */
export const resolveToolPermissionPolicies = (
	registry: AgentRegistry | null,
	agent: AgentId,
	getFallbackPermission: () => ToolPermission
): ResolvedToolPermissionPolicies => {
	// An unavailable registry fails closed: the caller's fallback permission
	// applies and no MCP tool is visible until the registry resolves.
	if (isNull(registry)) {
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
 * Composes the Tool Permission runtime for tool dispatch: the policy
 * evaluator seeded with defaults and refreshed from the top-level config
 * `permission` section once the ConfigStore snapshot resolves, the active
 * Agent's Tool Resource Profile, and the workspace sandbox used to
 * canonicalize read resources. Approval settlement is the Session Engine's,
 * not this runtime's. It is React-free, so a non-renderer consumer composes
 * it from the same call the TUI makes.
 */
export const createToolPermissionRuntime = ({
	agent,
	policyState,
	registry,
	service,
	workspace,
}: ToolPermissionRuntimeDeps): ToolPermissionRuntime => {
	const sandbox = createWorkspaceSandbox(workspace);
	const resolved = resolveToolPermissionPolicies(
		registry,
		agent,
		() => policyState.permission
	);
	// While the registry is loading, resolution fails closed but the state
	// keeps its previous value: a transient null never loosens a resolved
	// policy.
	if (!isNull(registry)) {
		policyState.permission = resolved.permission;
	}
	const resolvedPromise = Promise.resolve(resolved);
	const resolvePoliciesForAgent = (targetAgent: AgentId) =>
		resolveToolPermissionPolicies(
			registry,
			targetAgent,
			() => policyState.permission
		);

	return {
		resolveMcpPolicy: () =>
			resolvedPromise.then((resolvedPolicies) => resolvedPolicies.mcpPolicy),
		resolveMcpPolicyForAgent: (targetAgent) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).mcpPolicy),
		resolvePermission: () =>
			resolvedPromise.then((resolvedPolicies) => resolvedPolicies.permission),
		resolvePermissionForAgent: (targetAgent) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).permission),
		resolveResourceLimits: () =>
			resolvedPromise.then(
				(resolvedPolicies) => resolvedPolicies.resourceLimits
			),
		resolveResourceLimitsForAgent: (targetAgent) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).resourceLimits),
		sandbox,
		service,
	};
};
