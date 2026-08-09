import { z } from "zod";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import type { PermissionRules } from "./policy";

export const permissionDecisionSchema = z.enum(["allow", "ask", "deny"]);

export const permissionResourceMapSchema = z.record(
	z.string(),
	permissionDecisionSchema
);

export const permissionActionSchema = z.union([
	permissionDecisionSchema,
	permissionResourceMapSchema,
]);

// Action keys stay unconstrained: unknown action globs remain valid for MCP
// and future tools, and the policy evaluator ignores actions it does not gate.
export const topLevelPermissionSchema = z.record(
	z.string(),
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
