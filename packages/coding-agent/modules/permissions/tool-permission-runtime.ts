import type { AgentId } from "@wincode/agent-core";
import { isNull } from "@wincode/utils";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { WorkspacePolicy } from "@/modules/tools";
import {
	createWorkspaceSandbox,
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	type ToolResourceLimits,
} from "@/modules/tools";
import type { ConfigRuntime } from "@/shared/config/config-store";
import type { PermissionService } from "./permission-service";
import {
	applyManualApprovalSafetyCeiling,
	createResolvedToolPermission,
	DEFAULT_PERMISSION_RULES,
	type EffectiveAgentPolicy,
	isNativeToolPermissionAction,
	type PermissionDecision,
	type ToolPermission,
} from "./policy";
import { resolvePluginToolPermission } from "./resolve";

export type ToolPermissionRuntime = {
	resolveAgentActionPolicy: () => Promise<EffectiveAgentPolicy>;
	resolveAgentActionPolicyForAgent: (
		agent: AgentId
	) => Promise<EffectiveAgentPolicy>;
	resolvePermission: () => Promise<ToolPermission>;
	resolvePermissionForAgent: (agent: AgentId) => Promise<ToolPermission>;
	resolvePluginPermissionForAgent: (
		action: string,
		resource: string,
		agent?: AgentId
	) => Promise<Readonly<{ decision: PermissionDecision; safety: boolean }>>;
	resolveResourceLimits: () => Promise<ToolResourceLimits>;
	resolveResourceLimitsForAgent: (
		agent: AgentId
	) => Promise<ToolResourceLimits>;
	sandbox: WorkspacePolicy;
	service: PermissionService;
};

/**
 * Per-Agent fallbacks retained while the Agent registry is unavailable. A
 * resolution for one Agent can never replace another Agent's last known policy.
 */
export type ToolPermissionPolicyState = {
	permissions: Map<AgentId, ToolPermission>;
};

export type ToolPermissionRuntimeDeps = {
	agent: AgentId;
	getActiveAgent?: () => AgentId;
	policyState: ToolPermissionPolicyState;
	getRegistry: () => AgentRegistry | null;
	service: PermissionService;
	workspace: string;
	configRuntime?: ConfigRuntime;
};

type ResolvedToolPermissionPolicies = {
	agentActionPolicy: EffectiveAgentPolicy;
	permission: ToolPermission;
	resourceLimits: ToolResourceLimits;
};

const FAIL_CLOSED_AGENT_ACTION_POLICY: EffectiveAgentPolicy = {
	rules: { "*": "deny" } as EffectiveAgentPolicy["rules"],
	safety: true,
};

const FAIL_CLOSED_TOOL_PERMISSION: ToolPermission = {
	decide: () => "deny",
	rules: {},
	safety: true,
};

export const createToolPermissionPolicyState =
	(): ToolPermissionPolicyState => ({
		permissions: new Map(),
	});

/** Resolves one Agent's action policy without loosening it on failure. */
export const resolveToolPermissionPolicies = (
	registry: AgentRegistry | null,
	agent: AgentId,
	getFallbackPermission: () => ToolPermission
): ResolvedToolPermissionPolicies => {
	// An unavailable registry fails closed: the caller's fallback permission
	// applies and no open-action tool is visible until the registry resolves.
	if (isNull(registry)) {
		return {
			agentActionPolicy: FAIL_CLOSED_AGENT_ACTION_POLICY,
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
		// Open-action consumers receive the folded Agent rules and safety flag
		// and compose them with their own resource policy.
		agentActionPolicy: { rules, safety },
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
 * canonicalize read resources. Approval settlement is the Agent Session's,
 * not this runtime's. It is React-free, so a non-renderer consumer composes
 * it from the same call the TUI makes.
 */
export const createToolPermissionRuntime = ({
	agent,
	getActiveAgent,
	policyState,
	getRegistry,
	service,
	workspace,
	configRuntime,
}: ToolPermissionRuntimeDeps): ToolPermissionRuntime => {
	const sandbox = createWorkspaceSandbox(workspace);
	const fallbackPermissionForAgent = (targetAgent: AgentId): ToolPermission =>
		policyState.permissions.get(targetAgent) ?? FAIL_CLOSED_TOOL_PERMISSION;
	const initialRegistry = getRegistry();
	if (!isNull(initialRegistry)) {
		const resolved = resolveToolPermissionPolicies(initialRegistry, agent, () =>
			fallbackPermissionForAgent(agent)
		);
		policyState.permissions.set(agent, resolved.permission);
	}
	const resolvePoliciesForAgent = (targetAgent: AgentId) => {
		const registry = getRegistry();
		const resolved = resolveToolPermissionPolicies(registry, targetAgent, () =>
			fallbackPermissionForAgent(targetAgent)
		);
		// Retain only this Agent's last resolved policy across registry gaps.
		if (!isNull(registry)) {
			policyState.permissions.set(targetAgent, resolved.permission);
		}
		return resolved;
	};
	const currentAgent = (): AgentId =>
		getActiveAgent?.() ?? getRegistry()?.defaultAgentId ?? agent;

	return {
		resolveAgentActionPolicy: () =>
			Promise.resolve(
				resolvePoliciesForAgent(currentAgent()).agentActionPolicy
			),
		resolveAgentActionPolicyForAgent: (targetAgent) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).agentActionPolicy),
		resolvePermission: () =>
			Promise.resolve(resolvePoliciesForAgent(currentAgent()).permission),
		resolvePermissionForAgent: (targetAgent) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).permission),
		resolvePluginPermissionForAgent: async (action, resource, targetAgent) => {
			if (configRuntime === undefined) {
				return { decision: "ask", safety: true };
			}
			if (isNativeToolPermissionAction(action)) {
				// A Plugin's logical action cannot borrow a native tool's decision.
				// The registered tool is resolved later under its owner-qualified action.
				return { decision: "allow", safety: false };
			}
			const snapshot = await configRuntime.configStore.getSnapshot(workspace);
			const effectiveAgent = targetAgent ?? currentAgent();
			const pluginPermission = resolvePluginToolPermission(
				snapshot,
				effectiveAgent,
				action,
				resource
			);
			const agentPermission =
				resolvePoliciesForAgent(effectiveAgent).permission;
			const decision =
				agentPermission.safety && pluginPermission.decision !== "deny"
					? "ask"
					: pluginPermission.decision;
			return {
				decision,
				safety:
					pluginPermission.safety ||
					agentPermission.safety ||
					decision === "ask",
			};
		},
		resolveResourceLimits: () =>
			Promise.resolve(resolvePoliciesForAgent(currentAgent()).resourceLimits),
		resolveResourceLimitsForAgent: (targetAgent) =>
			Promise.resolve(resolvePoliciesForAgent(targetAgent).resourceLimits),
		sandbox,
		service,
	};
};
