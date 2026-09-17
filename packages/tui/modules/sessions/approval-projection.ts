import { isUndefined } from "@wincode/runtime-utils";
import type { ApprovalPanelEntry } from "@/shared/providers/approval/approval-panels-provider";
import type { ApprovalOutcome } from "@/shared/providers/approval/types";
import type { SessionApproval, SessionApprovalOutcome } from "./engine/types";

/** The panel's vocabulary for one approval settlement. */
const approvalOutcomeOf = (
	decision: SessionApprovalOutcome
): ApprovalOutcome => {
	if (decision.decision === "allow") {
		return decision.remember ? "always" : "allow-once";
	}
	return decision.decision === "reject" ? "rejected" : "aborted";
};

const approvalResolutionOf = (
	decision: SessionApprovalOutcome
): { feedback?: string; outcome: ApprovalOutcome } =>
	decision.decision === "reject" && !isUndefined(decision.feedback)
		? { feedback: decision.feedback, outcome: "rejected" }
		: { outcome: approvalOutcomeOf(decision) };

/**
 * Projects the Engine's approvals into the panel registry the session UI reads.
 * Every entry settles through the Engine's approval command, so the panel asks
 * for a settlement instead of applying one and the resolution it renders is the
 * Engine's own decision. A settled session entry is dropped: it has no timeline
 * anchor to render an audit line into, while a settled Tool Call entry stays so
 * its message part can show one.
 */
export const projectSessionApprovals = (
	approvals: readonly SessionApproval[],
	respondToApproval: (id: string, outcome: SessionApprovalOutcome) => void
): ApprovalPanelEntry[] =>
	approvals
		.filter(
			(approval) =>
				approval.target === "tool-call" || isUndefined(approval.decision)
		)
		.map((approval) => {
			const decision = approval.decision;
			return {
				actions: {
					abort: () => respondToApproval(approval.id, { decision: "abort" }),
					allow: (remember) =>
						respondToApproval(approval.id, { decision: "allow", remember }),
					cancel: () => respondToApproval(approval.id, { decision: "reject" }),
					reject: (feedback) =>
						respondToApproval(
							approval.id,
							isUndefined(feedback)
								? { decision: "reject" }
								: { decision: "reject", feedback }
						),
				},
				id: approval.id,
				request: approval.request,
				...(isUndefined(decision)
					? {}
					: { resolution: approvalResolutionOf(decision) }),
			};
		});
