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
 * the "always" grant; `safetyReason` replaces the default malformed-config
 * banner text when the safety flag comes from another ceiling (for example a
 * destructive shell command). `toolCallId` anchors the inline panel to the
 * assistant message part whose tool call is pending; approvals without one
 * (explicit Skill activation before the first model call) render as a
 * conversation-level panel instead.
 */
export type ToolApprovalRequest = {
	description: string;
	identity: readonly ApprovalIdentityRow[];
	input: unknown;
	safety?: boolean;
	safetyReason?: string;
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
