import { type CodingToolName, codingToolNames } from "@wincode/ai";

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionAction = "read" | "write" | "edit" | "list" | "grep";

export type PermissionResourceRules = Readonly<
	Record<string, PermissionDecision>
>;

export type PermissionRules = Readonly<
	Partial<
		Record<PermissionAction, PermissionDecision | PermissionResourceRules>
	>
>;

export type ToolPermission = {
	decide(action: PermissionAction, resource: string): PermissionDecision;
	/**
	 * True when a manual-only safety ceiling is in force. Every `ask` this
	 * evaluator returns is then a safety ask that later auto-approval and
	 * remembered-grant behavior must not bypass, distinguishing it from an
	 * ordinary `ask` produced by a trusted rule.
	 */
	readonly safety: boolean;
};

/**
 * Effective Agents are bounded so a malformed or hostile config cannot inflate
 * the policy without limit. A policy exceeding these bounds is treated as
 * malformed and driven under the manual-only safety ceiling.
 */
export const MAX_FLATTENED_PERMISSION_RULES = 256;
export const MAX_PERMISSION_PATTERN_LENGTH = 512;

/**
 * The tool-action names Wincode currently gates for static coding tools. Action
 * globs that match none of these (and none of the discovered MCP tool actions)
 * are inert today but remain in the effective policy in case a future or
 * temporarily unavailable tool matches them.
 */
export const PERMISSION_TOOL_ACTIONS = [
	"read",
	"edit",
	"list",
	"grep",
] as const satisfies readonly PermissionAction[];

/**
 * Maps each static coding tool to the Permission action that governs it. The
 * `write` tool is governed by the `edit` action so a single `edit` policy
 * covers both write and edit runtime tools, matching ADR 0003.
 */
export const STATIC_TOOL_PERMISSION_ACTIONS = {
	read: "read",
	write: "edit",
	edit: "edit",
	list: "list",
	grep: "grep",
} as const satisfies Record<CodingToolName, PermissionAction>;

/** Tightens every non-denied decision to an approval that must be handled manually. */
export function applyManualApprovalSafetyCeiling(
	permission: ToolPermission
): ToolPermission {
	return {
		decide(action, resource) {
			return permission.decide(action, resource) === "deny" ? "deny" : "ask";
		},
		safety: true,
	};
}

/**
 * Default read policy: ordinary reads are allowed, `.env` and `.env.*` reads
 * ask, and `.env.example` reads remain allowed. Order matters: the last
 * matching pattern wins, so `.env.example` (listed after `.env.*`) overrides
 * the `.env.*` ask with allow.
 */
export const DEFAULT_READ_PERMISSION_RULES: PermissionResourceRules = {
	".env": "ask",
	".env.*": "ask",
	".env.example": "allow",
};

export const DEFAULT_PERMISSION_RULES: PermissionRules = {
	read: DEFAULT_READ_PERMISSION_RULES,
	edit: "allow",
	list: "allow",
	grep: "allow",
};

/**
 * Shipped per-Agent Permission restrictions applied at the defaults layer, below
 * every config source. Plan denies `edit`, which also hides the write and edit
 * tools, until a valid higher policy explicitly overrides it.
 */
export const SHIPPED_AGENT_PERMISSION_RULES: Readonly<
	Record<string, PermissionRules>
> = {
	plan: { edit: "deny" },
};

/** Resolves the shipped defaults-layer Permission rules for an Agent id. */
export const shippedAgentPermissionRules = (agentId: string): PermissionRules =>
	SHIPPED_AGENT_PERMISSION_RULES[agentId] ?? {};

const isResourceMap = (
	value: PermissionDecision | PermissionResourceRules | undefined
): value is PermissionResourceRules =>
	typeof value === "object" && value !== null;

/**
 * Merges one Permission patch over a base following the shared ConfigStore
 * replacement contract: object-to-object patches preserve unaffected ordered
 * rules and append new patterns, while any scalar/object transition replaces the
 * lower subtree wholesale.
 */
export const mergePermissionRules = (
	base: PermissionRules,
	patch: PermissionRules
): PermissionRules => {
	const merged: Record<string, PermissionDecision | PermissionResourceRules> = {
		...base,
	};
	for (const action of Object.keys(patch) as PermissionAction[]) {
		const incoming = patch[action];
		if (incoming === undefined) {
			continue;
		}
		const current = merged[action];
		merged[action] =
			isResourceMap(current) && isResourceMap(incoming)
				? { ...current, ...incoming }
				: incoming;
	}
	return merged as PermissionRules;
};

/** Folds ordered Permission layers from lowest to highest precedence. */
export const foldPermissionRules = (
	layers: readonly PermissionRules[]
): PermissionRules =>
	layers.reduce<PermissionRules>(
		(accumulated, layer) => mergePermissionRules(accumulated, layer),
		{}
	);

const REGEX_SPECIAL_CHARS = /[*+?^${}()|[\]\\]/;

const escapeRegexChar = (char: string): string =>
	REGEX_SPECIAL_CHARS.test(char) ? `\\${char}` : char;

const globToRegExpSource = (pattern: string): string => {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index] as string;
		if (char === "*" && pattern[index + 1] === "*") {
			if (pattern[index + 2] === "/") {
				source += "(?:[^/]+/)*";
				index += 3;
			} else {
				source += ".*";
				index += 2;
			}
			continue;
		}
		if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegexChar(char);
		}
		index += 1;
	}
	return source;
};

/**
 * Matches a resource pattern against a workspace-relative POSIX resource. `*`
 * matches any characters except `/`, `?` matches one such character, and `**`
 * matches across directories. The last matching rule wins. A bare pattern with
 * no `/` also matches below any directory prefix, so `.env` covers
 * `apps/api/.env` as well as the workspace root.
 */
export function matchesResourcePattern(
	pattern: string,
	resource: string
): boolean {
	const source = globToRegExpSource(pattern);
	if (pattern.includes("/")) {
		return new RegExp(`^${source}$`).test(resource);
	}
	return new RegExp(`^(?:[^/]+/)*${source}$`).test(resource);
}

type NormalizedActionRule =
	| PermissionDecision
	| readonly { decision: PermissionDecision; pattern: string }[];

const normalizeRules = (
	rules: PermissionRules
): Partial<Record<PermissionAction, NormalizedActionRule>> => {
	const normalized: Partial<Record<PermissionAction, NormalizedActionRule>> =
		{};
	for (const action of Object.keys(rules) as PermissionAction[]) {
		const rule = rules[action];
		if (typeof rule === "string") {
			normalized[action] = rule;
			continue;
		}
		if (rule === undefined) {
			continue;
		}
		normalized[action] = Object.entries(rule).map(([pattern, decision]) => ({
			decision,
			pattern,
		}));
	}
	return normalized;
};

/**
 * Builds a policy evaluator from fully resolved rules without seeding defaults.
 * A missing action falls back to `allow`, a scalar action applies to every
 * resource, and a resource map applies the last matching pattern's decision,
 * falling back to `allow` when nothing matches.
 */
export function createResolvedToolPermission(
	rules: PermissionRules
): ToolPermission {
	const normalized = normalizeRules(rules);
	return {
		decide(action: PermissionAction, resource: string): PermissionDecision {
			const rule = normalized[action];
			if (rule === undefined) {
				return "allow";
			}
			if (typeof rule === "string") {
				return rule;
			}
			let decision: PermissionDecision = "allow";
			for (const entry of rule) {
				if (matchesResourcePattern(entry.pattern, resource)) {
					decision = entry.decision;
				}
			}
			return decision;
		},
		safety: false,
	};
}

/**
 * Builds the policy evaluator, seeded with the Wincode defaults unless rules are
 * given. Configured rules layer over the defaults following the shared
 * replacement contract, so a configured read map preserves the seeded `.env`
 * asks while a scalar action replaces them.
 */
export function createToolPermission(
	rules: PermissionRules | undefined = DEFAULT_PERMISSION_RULES
): ToolPermission {
	return createResolvedToolPermission(
		mergePermissionRules(DEFAULT_PERMISSION_RULES, rules)
	);
}

/**
 * A static tool is hidden from the model only when its governing action is an
 * unconditional scalar `deny`. Granular resource maps and `ask` scalars keep the
 * tool visible so it can be evaluated per resource at call time.
 */
export const isStaticToolUnconditionallyDenied = (
	rules: PermissionRules,
	tool: CodingToolName
): boolean => rules[STATIC_TOOL_PERMISSION_ACTIONS[tool]] === "deny";

/** Resolves the static coding tools a model may see, in canonical order. */
export const resolveVisibleCodingTools = (
	rules: PermissionRules
): CodingToolName[] =>
	codingToolNames.filter(
		(tool) => !isStaticToolUnconditionallyDenied(rules, tool)
	);

/**
 * Counts the flattened Permission Rules an effective policy expands to: one for
 * each scalar action and one for every pattern inside a resource map. Bounding
 * this count keeps a malformed or hostile policy from ballooning past the
 * effective-Agent limit.
 */
export const countFlattenedPermissionRules = (
	rules: PermissionRules
): number => {
	let count = 0;
	for (const action of Object.keys(rules)) {
		const rule = rules[action as PermissionAction];
		if (rule === undefined) {
			continue;
		}
		count += typeof rule === "string" ? 1 : Object.keys(rule).length;
	}
	return count;
};

/**
 * Finds action globs in the effective policy that match no known tool action.
 * Each action key is treated as a glob and tested against every known action
 * name; a key matching none is unmatched. Unmatched actions stay in the policy
 * (they may match a future or temporarily unavailable tool) but are surfaced so
 * a typo does not silently do nothing.
 */
export const findUnmatchedActionKeys = (
	rules: PermissionRules,
	knownActions: readonly string[] = PERMISSION_TOOL_ACTIONS
): string[] =>
	Object.keys(rules).filter(
		(actionKey) =>
			!knownActions.some((name) => matchesResourcePattern(actionKey, name))
	);
