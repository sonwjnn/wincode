import type { WorkspacePolicy } from "@wincode/ai/workspace";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";
import { useCallback, useMemo, useRef } from "react";
import { useConfig } from "@/shared/config/config-provider";
import type { ApprovalController } from "@/shared/providers/approval/approval-controller";
import {
	ToolApprovalDialog,
	type ToolApprovalRequest,
} from "@/shared/providers/approval/ui/tool-approval-dialog";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { createToolPermission, type ToolPermission } from "./policy";
import { resolveTopLevelPermission } from "./schema";

type MutableRefObject<T> = { current: T };

export type ToolPermissionRuntime = {
	openApproval: (
		request: ToolApprovalRequest,
		controller: ApprovalController<ToolApprovalRequest>
	) => void;
	permissionRef: MutableRefObject<ToolPermission>;
	resolvePermission: () => Promise<ToolPermission>;
	sandbox: WorkspacePolicy;
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
	const permissionRef = useRef<ToolPermission>(createToolPermission());
	const sandbox = useMemo(
		() => createWorkspaceSandbox(config.workspace),
		[config]
	);
	const permissionPromise = useMemo(
		() =>
			config.configStore
				.getSnapshot(config.workspace)
				.then((snapshot) => {
					permissionRef.current = createToolPermission(
						resolveTopLevelPermission(snapshot)
					);
					return permissionRef.current;
				})
				.catch(() => permissionRef.current),
		[config]
	);
	const resolvePermission = useCallback(
		() => permissionPromise,
		[permissionPromise]
	);

	const openApproval = useCallback(
		(
			request: ToolApprovalRequest,
			controller: ApprovalController<ToolApprovalRequest>
		) => {
			dialog.open({
				children: (
					<ToolApprovalDialog controller={controller} request={request} />
				),
				title: "Tool approval",
				width: 100,
			});
		},
		[dialog]
	);

	return { openApproval, permissionRef, resolvePermission, sandbox };
}
