import {
	type ApprovalController,
	createApprovalController,
} from "@/shared/providers/approval/approval-controller";
import type { McpApprovalRequest } from "../registry";

export type McpApprovalController = ApprovalController<McpApprovalRequest>;

export const createMcpApprovalController = (): McpApprovalController =>
	createApprovalController<McpApprovalRequest>();
