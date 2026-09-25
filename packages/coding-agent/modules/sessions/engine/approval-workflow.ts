import type { ToolCallId } from "@wincode/agent-core";
import { isUndefined } from "@wincode/runtime-utils";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	SessionApproval,
	SessionApprovalOutcome,
	SessionApprovalResult,
	SessionSnapshot,
} from "./types";

type ApprovalSettlement = (outcome: SessionApprovalOutcome) => void;

/** The Agent Session authority the approval workflow may ask to transition. */
export type SessionApprovalWorkflowPort = Readonly<{
	abortTurn: (toolCallId?: ToolCallId) => void;
	allocateSessionApprovalId: () => string;
	applyApprovals: (approvals: SessionApproval[]) => void;
	getSettlement: (id: string) => ApprovalSettlement | undefined;
	getSnapshot: () => SessionSnapshot;
	isClosed: () => boolean;
	removeSettlement: (id: string) => void;
	saveSettlement: (id: string, resolve: ApprovalSettlement) => void;
}>;

export type SessionApprovalWorkflow = Readonly<{
	close: (feedback?: string) => void;
	request: (request: ToolApprovalRequest) => Promise<SessionApprovalOutcome>;
	settle: (
		id: string,
		outcome: SessionApprovalOutcome
	) => SessionApprovalResult;
}>;

/** Approval policy is extracted; records and settlement ownership remain in Agent Session. */
export const createSessionApprovalWorkflow = (
	port: SessionApprovalWorkflowPort
): SessionApprovalWorkflow => {
	const settle = (
		id: string,
		outcome: SessionApprovalOutcome
	): SessionApprovalResult => {
		const resolveApproval = port.getSettlement(id);
		const approval = port
			.getSnapshot()
			.approvals.find(
				(candidate) => candidate.id === id && isUndefined(candidate.decision)
			);
		if (resolveApproval === undefined || approval === undefined) {
			return { applied: false };
		}
		if (
			outcome.decision === "allow" &&
			outcome.remember &&
			approval.request.safety === true
		) {
			return { applied: false, reason: "persistence-forbidden" };
		}
		port.removeSettlement(id);
		port.applyApprovals(
			port
				.getSnapshot()
				.approvals.map((candidate) =>
					candidate.id === id ? { ...candidate, decision: outcome } : candidate
				)
		);
		if (outcome.decision === "abort") {
			close();
			port.abortTurn(approval.request.toolCallId);
		}
		resolveApproval(outcome);
		return { applied: true };
	};
	const request = (
		request: ToolApprovalRequest
	): Promise<SessionApprovalOutcome> => {
		if (port.isClosed()) {
			return Promise.resolve({ decision: "reject" });
		}
		const id = request.toolCallId ?? port.allocateSessionApprovalId();
		if (port.getSettlement(id) !== undefined) {
			return Promise.resolve({ decision: "reject" });
		}
		const { promise, resolve } =
			Promise.withResolvers<SessionApprovalOutcome>();
		port.saveSettlement(id, resolve);
		port.applyApprovals([
			...port.getSnapshot().approvals,
			{
				id,
				request,
				target: isUndefined(request.toolCallId) ? "session" : "tool-call",
			},
		]);
		return promise;
	};
	const close = (feedback?: string): void => {
		const pending = port
			.getSnapshot()
			.approvals.filter((approval) => isUndefined(approval.decision));
		const selectedId = isUndefined(feedback) ? undefined : pending.at(-1)?.id;
		for (const approval of pending) {
			settle(
				approval.id,
				approval.id === selectedId
					? { decision: "reject", feedback }
					: { decision: "reject" }
			);
		}
	};
	return { close, request, settle };
};
