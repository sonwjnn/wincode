import {
	ToolApprovalDialogContent,
	type ToolApprovalRequest,
} from "@/shared/providers/approval/ui/tool-approval-dialog";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import type { McpApprovalController } from "../context/approval-controller";
import type { McpApprovalRequest } from "../registry";

export {
	formatApprovalDescription,
	MAX_DESCRIPTION_CHARS,
} from "@/shared/providers/approval/format";

type McpApprovalDialogContentProps = {
	controller: McpApprovalController;
	onClose: () => void;
	request: McpApprovalRequest;
};

export function McpApprovalDialogContent({
	controller,
	onClose,
	request,
}: McpApprovalDialogContentProps) {
	const approvalRequest: ToolApprovalRequest = {
		description: request.description,
		identity: [
			{ label: "server", value: request.serverName },
			{ label: "tool", value: request.originalToolName },
		],
		input: request.input,
	};
	return (
		<ToolApprovalDialogContent
			controller={controller}
			onClose={onClose}
			request={approvalRequest}
		/>
	);
}

type McpApprovalDialogProps = {
	controller: McpApprovalController;
	request: McpApprovalRequest;
};

export function McpApprovalDialog({
	controller,
	request,
}: McpApprovalDialogProps) {
	const { close } = useDialog();
	useDialogEscape();
	return (
		<McpApprovalDialogContent
			controller={controller}
			onClose={close}
			request={request}
		/>
	);
}
