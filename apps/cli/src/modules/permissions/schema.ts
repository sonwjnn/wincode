import { z } from "zod";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { MAX_PERMISSION_PATTERN_LENGTH, type PermissionRules } from "./policy";

export const permissionDecisionSchema = z.enum(["allow", "ask", "deny"]);

// Resource patterns are bounded so a malformed or hostile config cannot smuggle
// in an unbounded glob that is expensive to compile or match.
const permissionPatternSchema = z.string().max(MAX_PERMISSION_PATTERN_LENGTH);

export const permissionResourceMapSchema = z.record(
	permissionPatternSchema,
	permissionDecisionSchema
);

export const permissionActionSchema = z.union([
	permissionDecisionSchema,
	permissionResourceMapSchema,
]);

// Action keys stay semantically unconstrained: unknown action globs remain
// valid for MCP and future tools, and the policy evaluator ignores actions it
// does not gate. They are only length-bounded like resource patterns.
export const topLevelPermissionSchema = z.record(
	permissionPatternSchema,
	permissionActionSchema
);

/**
 * Resolves the top-level `permission` section from a config snapshot.
 * Returns `undefined` when the section is absent or invalid so callers fall
 * back to the seeded defaults.
 */
export function resolveTopLevelPermission(
	snapshot: ConfigSnapshot
): PermissionRules | undefined {
	const raw = snapshot.document.permission;
	if (raw === undefined) {
		return;
	}
	const parsed = topLevelPermissionSchema.safeParse(raw);
	if (!parsed.success) {
		return;
	}
	return parsed.data as PermissionRules;
}
