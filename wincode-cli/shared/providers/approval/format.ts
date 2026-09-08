import {
	sanitizeArgumentTree,
	truncateWithOverflow,
} from "@/shared/display-sanitize";

export const MAX_DESCRIPTION_CHARS = 2048;
export const MAX_IDENTITY_CHARS = 512;
export const MAX_FEEDBACK_CHARS = 2048;
const MAX_INPUT_CHARS = 2048;

// The approval dialog shows more of the input than the compact chat rows:
// deeper traversal, more entries, and a plain ellipsis for the depth bound.
const APPROVAL_ARGUMENT_OPTIONS = {
	depthOverflow: "…",
	maxDepth: 4,
	maxEntries: 24,
	redactValuesInKeys: true,
} as const;

/**
 * Formats the tool-call input for display, bounded so a hostile or enormous
 * tool schema cannot flood the dialog. Never renders config, credentials,
 * headers, or URLs — only the tool-call arguments the model produced.
 */
export function formatApprovalInput(input: unknown): string {
	const text =
		JSON.stringify(
			sanitizeArgumentTree(input, APPROVAL_ARGUMENT_OPTIONS),
			null,
			2
		) ?? "";
	return truncateWithOverflow(text, MAX_INPUT_CHARS);
}

/**
 * Formats the tool description for display, bounded so a hostile or enormous
 * tool schema cannot flood the dialog.
 */
export function formatApprovalDescription(description: string): string {
	return truncateWithOverflow(description, MAX_DESCRIPTION_CHARS);
}

export function formatApprovalIdentity(identity: string): string {
	return truncateWithOverflow(identity, MAX_IDENTITY_CHARS);
}

/**
 * Bounds the user's rejection feedback before it is returned to the Agent, so a
 * pasted or runaway correction cannot flood the Agent's next turn. Returns
 * undefined when the trimmed feedback is empty so no empty correction is sent.
 */
export function formatRejectionFeedback(
	feedback: string | undefined
): string | undefined {
	if (feedback === undefined) {
		return;
	}
	const trimmed = feedback.trim();
	if (trimmed.length === 0) {
		return;
	}
	return truncateWithOverflow(trimmed, MAX_FEEDBACK_CHARS);
}
