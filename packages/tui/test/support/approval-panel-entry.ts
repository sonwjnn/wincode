import type { ApprovalPanelEntry } from "@/shared/providers/approval/approval-panels-provider";
import type {
	ToolApprovalActions,
	ToolApprovalRequest,
} from "@/shared/providers/approval/types";

const noop = (): void => undefined;

/** Approval actions that record nothing, for a panel that is only rendered. */
export const inertApprovalActions = (): ToolApprovalActions => ({
	abort: noop,
	allow: noop,
	cancel: noop,
	reject: noop,
});

/**
 * One approval as the session projects it into the panel surface: the request
 * keeps its Tool Call Identifier, and a resolution is present only once the
 * session has settled it.
 */
export const approvalPanelEntry = (
	request: ToolApprovalRequest,
	options: {
		actions?: ToolApprovalActions;
		resolution?: ApprovalPanelEntry["resolution"];
	} = {}
): ApprovalPanelEntry => ({
	actions: options.actions ?? inertApprovalActions(),
	id: request.toolCallId ?? "session-1",
	request,
	...(options.resolution === undefined
		? {}
		: { resolution: options.resolution }),
});
