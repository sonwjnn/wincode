/** One settlement decision for an approval request. */
export type SessionApprovalOutcome =
	| { decision: "abort" }
	| { decision: "allow"; remember: boolean }
	| { decision: "reject"; feedback?: string };
