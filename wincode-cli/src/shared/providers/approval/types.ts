export type ApprovalIdentityRow = {
	label: string;
	value: string;
};

/**
 * One generic bounded tool-approval request. `identity` carries the tool
 * identity and canonical resource rows (for example `tool`/`resource`), while
 * `description` and `input` are the bounded tool description and call input.
 * `safety` marks an approval that must always be handled manually, so the
 * panel can warn that auto approval and grants cannot bypass it and suppress
 * the "always" grant; it is set only by the manual-approval safety ceiling
 * (malformed config / `requiresManualApproval` agents, ADR-0008). `toolCallId`
 * anchors the inline panel to the assistant message part whose tool call is
 * pending; approvals without one (explicit Skill activation before the first
 * model call) render as a conversation-level panel instead.
 */
export type ToolApprovalRequest = {
	description: string;
	identity: readonly ApprovalIdentityRow[];
	input: unknown;
	safety?: boolean;
	toolCallId?: string;
};

/**
 * The imperative surface the panel drives. `reject` blocks only the selected
 * tool call so the Agent may continue, while `abort` rejects the conversation's
 * pending approvals and interrupts the active turn. `cancel` rejects only the
 * selected request when the panel is dismissed.
 */
export type ToolApprovalActions = {
	abort(): void;
	allow(remember: boolean): void;
	reject(feedback?: string): void;
	cancel(): void;
};

export type ApprovalOutcome = "aborted" | "allow-once" | "always" | "rejected";
