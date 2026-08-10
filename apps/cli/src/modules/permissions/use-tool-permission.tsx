import type { WorkspacePolicy } from "@wincode/ai/workspace";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import { useCallback, useMemo, useRef } from "react";
import { resolveAgentRegistry } from "@/modules/agents";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useConfig } from "@/shared/config/config-provider";
import {
	type ToolApprovalActions,
	ToolApprovalDialog,
	type ToolApprovalRequest,
} from "@/shared/providers/approval/ui/tool-approval-dialog";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import type { PermissionService } from "./permission-service";
import { usePermissionService } from "./permission-service-provider";
import {
	applyManualApprovalSafetyCeiling,
	createResolvedToolPermission,
	createToolPermission,
	DEFAULT_PERMISSION_RULES,
	type ToolPermission,
} from "./policy";

type MutableRefObject<T> = { current: T };

export type ToolPermissionRuntime = {
	openApproval: (
		request: ToolApprovalRequest,
		actions: ToolApprovalActions
	) => void;
	permissionRef: MutableRefObject<ToolPermission>;
	resolvePermission: () => Promise<ToolPermission>;
	sandbox: WorkspacePolicy;
	service: PermissionService;
};

/**
 * Composes the Tool Permission runtime for chat tool dispatch: the policy
 * evaluator seeded with defaults and refreshed from the top-level config
 * `permission` section once the ConfigStore snapshot resolves, the workspace
 * sandbox used to canonicalize read resources, and the dialog opener for
 * `ask` decisions.
 */
export function useToolPermission(): ToolPermissionRuntime {
	const config = useConfig();
	const dialog = useDialog();
	const service = usePermissionService();
	const { agent } = usePromptConfig();
	const permissionRef = useRef<ToolPermission>(createToolPermission());
	const sandbox = useMemo(
		() => createWorkspaceSandbox(config.workspace),
		[config]
	);
	const permissionPromise = useMemo(
		() =>
			resolveAgentRegistry(config)
				.then((registry) => {
					// Enforce against the Agent that actually runs: an unavailable
					// selection falls back to Build, mirroring the effective-selection
					// resolution used when the message is sent, so tool visibility and
					// policy stay consistent with the executing Agent.
					const effectiveAgent =
						registry.agents.find(
							({ id, isAvailable }) => id === agent && isAvailable
						) ?? registry.agents.find(({ id }) => id === "build");
					const permission = createResolvedToolPermission(
						effectiveAgent?.permission ?? DEFAULT_PERMISSION_RULES
					);
					permissionRef.current = effectiveAgent?.requiresManualApproval
						? applyManualApprovalSafetyCeiling(permission)
						: permission;
					return permissionRef.current;
				})
				.catch(() => permissionRef.current),
		[agent, config]
	);
	const resolvePermission = useCallback(
		() => permissionPromise,
		[permissionPromise]
	);

	const openApproval = useCallback(
		(request: ToolApprovalRequest, actions: ToolApprovalActions) => {
			dialog.open({
				children: <ToolApprovalDialog actions={actions} request={request} />,
				title: "Tool approval",
				width: 100,
			});
		},
		[dialog]
	);

	return { openApproval, permissionRef, resolvePermission, sandbox, service };
}
