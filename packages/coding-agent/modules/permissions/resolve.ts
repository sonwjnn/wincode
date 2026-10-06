import { isPlainObject, isUndefined } from "@wincode/utils";
import type {
	ConfigDocument,
	ConfigOrigin,
	ConfigSnapshot,
} from "@/shared/config/config-store";
import {
	composePermissionDecisions,
	countFlattenedPermissionRules,
	createResolvedToolPermission,
	DEFAULT_PERMISSION_RULES,
	findUnmatchedActionKeys,
	foldPermissionRules,
	MAX_FLATTENED_PERMISSION_RULES,
	PERMISSION_TOOL_ACTIONS,
	type PermissionAction,
	type PermissionDecision,
	type PermissionRules,
} from "./policy";
import { topLevelPermissionSchema } from "./schema";

export type PermissionDiagnosticCode =
	| "invalid-permission-policy"
	| "permission-rule-limit"
	| "unmatched-permission-action";

export type PermissionDiagnostic = Readonly<{
	code: PermissionDiagnosticCode;
	configPath: readonly string[];
	message: string;
	origin?: ConfigOrigin;
	severity: "error" | "warning";
}>;

/**
 * The fully resolved Permission policy for one selected Agent: the effective
 * folded rules, whether a manual-only safety ceiling must apply, and any
 * diagnostics raised while resolving. A safety ceiling is set when a present
 * top-level policy is malformed or the effective policy exceeds its bounds; it
 * is never cleared by lower-precedence rules.
 */
export type ResolvedAgentPermission = Readonly<{
	diagnostics: readonly PermissionDiagnostic[];
	rules: PermissionRules;
	safetyCeiling: boolean;
}>;

export type ResolveAgentPermissionOptions = Readonly<{
	discoveredToolActions?: readonly string[];
}>;

const parsePermissionRules = (raw: unknown): PermissionRules | undefined => {
	if (isUndefined(raw)) {
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
	if (!isPlainObject(agents)) {
		return;
	}
	const agent = agents[agentId];
	return isPlainObject(agent) ? agent.permission : undefined;
};

/**
 * Resolves the effective Permission policy for one selected Agent using
 * source-first precedence: Wincode defaults come first, then each config source
 * from low to high precedence, with a source's top-level policy applied before
 * that Agent's policy.
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
	const layers: PermissionRules[] = [DEFAULT_PERMISSION_RULES];
	for (const source of snapshot.sources) {
		const origin: ConfigOrigin = { path: source.path, scope: source.scope };
		const rawTopLevel = source.document.permission;
		if (!isUndefined(rawTopLevel)) {
			const topLevel = parsePermissionRules(rawTopLevel);
			if (isUndefined(topLevel)) {
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
		if (!isUndefined(agentLevel)) {
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
	const knownActions = isUndefined(options.discoveredToolActions)
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

export type ResolvedPluginToolPermission = Readonly<{
	decision: PermissionDecision;
	safety: boolean;
}>;

/**
 * Resolves one Plugin Tool action with an `ask` default. Global user rules may
 * grant it; each project layer is composed most-restrictively and can never
 * turn a user ask or the default ask into an allow.
 */
export const resolvePluginToolPermission = (
	snapshot: ConfigSnapshot,
	agentId: string,
	action: PermissionAction
): ResolvedPluginToolPermission => {
	const globalLayers: PermissionRules[] = [
		{ [action]: "ask" } as PermissionRules,
	];
	const projectLayers: PermissionRules[] = [];
	for (const source of snapshot.sources) {
		const sourceLayers = [
			parsePermissionRules(source.document.permission),
			parsePermissionRules(agentPermissionRaw(source.document, agentId)),
		].filter((rules): rules is PermissionRules => !isUndefined(rules));
		if (source.scope === "global") {
			globalLayers.push(...sourceLayers);
		} else {
			projectLayers.push(...sourceLayers);
		}
	}

	let decision = createResolvedToolPermission(
		foldPermissionRules(globalLayers)
	).decide(action, "*");
	let safety =
		decision === "ask" ||
		resolveAgentPermission(snapshot, agentId).safetyCeiling;
	for (const rules of projectLayers) {
		const projectDecision = createResolvedToolPermission(rules).decide(
			action,
			"*"
		);
		decision = composePermissionDecisions(decision, projectDecision);
		if (projectDecision === "ask") {
			safety = true;
		}
	}
	return { decision, safety };
};
