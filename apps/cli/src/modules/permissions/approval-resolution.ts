import type { PermissionAction, PermissionDecision } from "./policy";

/**
 * The effective approval outcome after temporary grants and auto approval are
 * applied on top of a raw policy decision. `allow` runs the tool without a
 * prompt, `deny` blocks it, and `ask` still requires an interactive approval.
 */
export type EffectiveApproval = "allow" | "ask" | "deny";

export type ApprovalResolutionContext = {
	decision: PermissionDecision;
	/** True when the governing evaluator is under the manual-only safety ceiling. */
	safety: boolean;
	action: PermissionAction;
	resource: string;
	isGranted: (action: PermissionAction, resource: string) => boolean;
	isAutoApproval: () => boolean;
};

/**
 * Applies temporary grants and auto approval to a raw policy decision.
 *
 * An explicit `deny` is always preserved. A safety `ask` (raised by the
 * manual-only ceiling over malformed config) stays a manual `ask`, so neither a
 * remembered grant nor auto approval can bypass it. An ordinary `ask` is
 * satisfied by an exact temporary grant or by auto approval, otherwise it
 * remains an `ask`. An `allow` passes through.
 */
export function resolveApproval(
	context: ApprovalResolutionContext
): EffectiveApproval {
	if (context.decision === "deny") {
		return "deny";
	}
	if (context.decision === "allow") {
		return "allow";
	}
	if (context.safety) {
		return "ask";
	}
	if (context.isGranted(context.action, context.resource)) {
		return "allow";
	}
	if (context.isAutoApproval()) {
		return "allow";
	}
	return "ask";
}
