export type ApprovalIdentityRow = {
	label: string;
	value: string;
};

/**
 * One generic bounded tool-approval request. `identity` carries the tool
 * identity and canonical resource rows (for example `tool`/`resource`), while
 * `description` and `input` are the bounded tool description and call input.
 * `safety` marks an approval raised by the manual-only safety ceiling, so the
 * panel can warn that the governing config is untrusted and suppress the
 * "always" grant that a safety ask must never create. `toolCallId` anchors the
 * inline panel to the assistant message part whose tool call is pending;
 * approvals without one (explicit Skill activation before the first model
 * call) render as a conversation-level panel instead.
 */
export type ToolApprovalRequest = {
	description: string;
	identity: readonly ApprovalIdentityRow[];
	input: unknown;
	safety?: boolean;
	toolCallId?: string;
};

/**
 * The imperative surface the panel drives. `allow` runs the tool once, and
 * `remember` records a temporary grant for the exact action/resource. `reject`
 * blocks the tool and returns the optional typed correction to the Agent, and —
 * because the queue behind it is conversation-scoped — settles every other
 * pending approval in the same conversation. `cancel` rejects without feedback
 * when the panel unmounts or the user presses escape.
 */
export type ToolApprovalActions = {
	allow(remember: boolean): void;
	reject(feedback?: string): void;
	cancel(): void;
};

export type ApprovalOutcome = "allow-once" | "always" | "rejected";
