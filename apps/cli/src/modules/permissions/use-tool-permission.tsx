import type { AgentId } from "@wincode/ai";
import type { WorkspacePolicy } from "@wincode/ai/workspace";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import { useCallback, useMemo, useRef } from "react";
import { resolveAgentRegistry } from "@/modules/agents";
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
	resolvePermission: () => Promise<ToolPermission>;
	sandbox: WorkspacePolicy;
	service: PermissionService;
};

type ResolvedToolPermissionPolicies = {
	mcpPolicy: EffectiveAgentPolicy;
	permission: ToolPermission;
};

const FAIL_CLOSED_MCP_POLICY: EffectiveAgentPolicy = {
	rules: { "*": "deny" } as EffectiveAgentPolicy["rules"],
	safety: true,
};

/** Resolves one Agent's static and MCP policies without loosening MCP on failure. */
export const resolveToolPermissionPolicies = (
	registryPromise: ReturnType<typeof resolveAgentRegistry>,
	agent: AgentId,
	getFallbackPermission: () => ToolPermission
): Promise<ResolvedToolPermissionPolicies> =>
	registryPromise
		.then((registry) => {
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
			return {
				// MCP composition consumes the raw folded rules plus the safety flag;
				// the ceiling is applied by the registry when it composes with each
				// server's own policy, so it must not be pre-applied here.
				mcpPolicy: { rules, safety },
				permission: safety
					? applyManualApprovalSafetyCeiling(permission)
					: permission,
			};
		})
		.catch(() => ({
			mcpPolicy: FAIL_CLOSED_MCP_POLICY,
			permission: getFallbackPermission(),
		}));

/**
 * Composes the Tool Permission runtime for chat tool dispatch: the policy
 * evaluator seeded with defaults and refreshed from the top-level config
 * `permission` section once the ConfigStore snapshot resolves, the workspace
 * sandbox used to canonicalize read resources, and the inline approval panel
 * registry for `ask` decisions.
 */
export function useToolPermission(): ToolPermissionRuntime {
	const config = useConfig();
	const { add, resolveAll } = useApprovalPanels();
	const service = usePermissionService();
	const { agent } = usePromptConfig();
	const permissionRef = useRef<ToolPermission>(createToolPermission());
	const mcpPolicyRef = useRef<EffectiveAgentPolicy>(
		DEFAULT_EFFECTIVE_AGENT_POLICY
	);
	const sandbox = useMemo(
		() => createWorkspaceSandbox(config.workspace),
		[config]
	);
	const resolvedPromise = useMemo(
		() =>
			resolveToolPermissionPolicies(
				resolveAgentRegistry(config),
				agent,
				() => permissionRef.current
			).then((resolved) => {
				permissionRef.current = resolved.permission;
				mcpPolicyRef.current = resolved.mcpPolicy;
				return {
					mcpPolicy: mcpPolicyRef.current,
					permission: permissionRef.current,
				};
			}),
		[agent, config]
	);
	const resolvePermission = useCallback(
		() => resolvedPromise.then((resolved) => resolved.permission),
		[resolvedPromise]
	);
	const resolveMcpPolicy = useCallback(
		() => resolvedPromise.then((resolved) => resolved.mcpPolicy),
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
		resolvePermission,
		sandbox,
		service,
	};
}
