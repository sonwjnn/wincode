import type {
	ConfigDocument,
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import {
	countFlattenedPermissionRules,
	DEFAULT_PERMISSION_RULES,
	findUnmatchedActionKeys,
	foldPermissionRules,
	MAX_FLATTENED_PERMISSION_RULES,
	PERMISSION_TOOL_ACTIONS,
	type PermissionRules,
	shippedAgentPermissionRules,
} from "./policy";
import { topLevelPermissionSchema } from "./schema";

export type PermissionDiagnosticCode =
	| "invalid-permission-policy"
	| "permission-rule-limit"
	| "unmatched-permission-action";

export type PermissionDiagnostic = {
	readonly code: PermissionDiagnosticCode;
	readonly configPath: readonly string[];
	readonly message: string;
	readonly origin?: ConfigOrigin;
	readonly severity: "error" | "warning";
};

/**
 * The fully resolved Permission policy for one selected Agent: the effective
 * folded rules, whether a manual-only safety ceiling must apply, and any
 * diagnostics raised while resolving. A safety ceiling is set when a present
 * top-level policy is malformed or the effective policy exceeds its bounds; it
 * is never cleared by lower-precedence rules.
 */
export type ResolvedAgentPermission = {
	readonly diagnostics: readonly PermissionDiagnostic[];
	readonly rules: PermissionRules;
	readonly safetyCeiling: boolean;
};

export type ResolveAgentPermissionOptions = {
	readonly discoveredToolActions?: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parsePermissionRules = (raw: unknown): PermissionRules | undefined => {
	if (raw === undefined) {
		return;
	}
	const parsed = topLevelPermissionSchema.safeParse(raw);
	return parsed.success ? (parsed.data as PermissionRules) : undefined;
};

const agentPermissionRaw = (
	document: ConfigDocument,
	agentId: string
): unknown => {
	const agents = document.agents;
	if (!isRecord(agents)) {
		return;
	}
	const agent = agents[agentId];
	return isRecord(agent) ? agent.permission : undefined;
};

/**
 * Resolves the effective Permission policy for one selected Agent using
 * source-first precedence: the Wincode defaults and the Agent's shipped
 * restrictions come first, then each config source from low to high precedence,
 * with a source's top-level policy applied before that Agent's policy.
 *
 * A present top-level `permission` that is malformed does not partially apply
 * and does not fall back to permissive defaults; it is skipped as a policy layer
 * and instead raises the manual-only safety ceiling so effective allows become
 * asks while lower-precedence denies stay preserved. The effective policy is
 * bounded, and action globs matching no known tool stay active but are reported.
 */
export const resolveAgentPermission = (
	snapshot: ConfigSnapshot,
	agentId: string,
	options: ResolveAgentPermissionOptions = {}
): ResolvedAgentPermission => {
	const diagnostics: PermissionDiagnostic[] = [];
	let safetyCeiling = false;
	const layers: PermissionRules[] = [
		DEFAULT_PERMISSION_RULES,
		shippedAgentPermissionRules(agentId),
	];
	for (const source of snapshot.sources) {
		const origin: ConfigOrigin = { path: source.path, scope: source.scope };
		const rawTopLevel = source.document.permission;
		if (rawTopLevel !== undefined) {
			const topLevel = parsePermissionRules(rawTopLevel);
			if (topLevel === undefined) {
				safetyCeiling = true;
				diagnostics.push({
					code: "invalid-permission-policy",
					configPath: ["permission"],
					message:
						"Top-level Tool Permission policy is malformed; applying a manual-only safety ceiling and preserving denies instead of the permissive defaults",
					origin,
					severity: "error",
				});
			} else {
				layers.push(topLevel);
			}
		}
		// Malformed per-Agent permission subtrees are owned by the Agent Registry,
		// which retains the shipped Agent under the same safety ceiling; here they
		// are simply skipped so lower-precedence rules stay in effect.
		const agentLevel = parsePermissionRules(
			agentPermissionRaw(source.document, agentId)
		);
		if (agentLevel !== undefined) {
			layers.push(agentLevel);
		}
	}
	const rules = foldPermissionRules(layers);
	if (countFlattenedPermissionRules(rules) > MAX_FLATTENED_PERMISSION_RULES) {
		safetyCeiling = true;
		diagnostics.push({
			code: "permission-rule-limit",
			configPath: ["permission"],
			message: `Effective Tool Permission policy exceeds the ${MAX_FLATTENED_PERMISSION_RULES}-rule limit; applying a manual-only safety ceiling`,
			origin: snapshot.sourceFor(["permission"]),
			severity: "error",
		});
	}
	const knownActions =
		options.discoveredToolActions === undefined
			? PERMISSION_TOOL_ACTIONS
			: [...PERMISSION_TOOL_ACTIONS, ...options.discoveredToolActions];
	for (const action of findUnmatchedActionKeys(rules, knownActions)) {
		diagnostics.push({
			code: "unmatched-permission-action",
			configPath: ["permission", action],
			message: `Permission action "${action}" matches no current static or discovered tool; it stays active for a future or unavailable tool`,
			origin:
				snapshot.sourceFor(["permission", action]) ??
				snapshot.sourceFor(["agents", agentId, "permission", action]),
			severity: "warning",
		});
	}
	return { diagnostics, rules, safetyCeiling };
};
