import { type CodingToolName, codingToolNames } from "@wincode/ai";
import { expandHomeInPath } from "./external-directory";

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionAction =
	| "read"
	| "write"
	| "edit"
	| "list"
	| "glob"
	| "grep"
	| "shell"
	| "skill"
	| "external_directory";

export type PermissionResourceRules = Readonly<
	Record<string, PermissionDecision>
>;

export type PermissionRules = Readonly<
	Partial<
		Record<PermissionAction, PermissionDecision | PermissionResourceRules>
	>
>;

/**
 * A snapshot of one Agent's effective Tool Permission as it applies to
 * open-glob-action tools such as MCP: the folded rules to match logical tool
 * names against, and whether the Agent runs under the manual-only safety
 * ceiling. Tool-family neutral so the engine — not any one tool module — owns
 * the shape.
 */
export type EffectiveAgentPolicy = {
	rules: PermissionRules;
	safety: boolean;
};

/**
 * The permissive default effective policy: no rules and no safety ceiling. A
 * consumer that resolves a tool family's policy (e.g. MCP snapshots) uses this
 * until the executing Agent's real policy is known, so composition starts from
 * "the Agent imposes nothing" rather than from a hidden restriction.
 */
export const DEFAULT_EFFECTIVE_AGENT_POLICY: EffectiveAgentPolicy = {
	rules: {},
	safety: false,
};

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
	"glob",
	"grep",
	"shell",
	"skill",
	"external_directory",
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
	glob: "glob",
	grep: "grep",
	shell: "shell",
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

/**
 * The shipped default shell rules (ADR-0008): harmless commands run without
 * approval while `rm` and `sudo` are denied by default. The catch-all must
 * come first: last-match-wins would otherwise let `"*"` silently override
 * every specific rule. The denies are ordinary overridable rules, so a
 * configured `shell` map can turn them back into `ask` or `allow` per family.
 */
export const DEFAULT_SHELL_PERMISSION_RULES: PermissionResourceRules = {
	"*": "allow",
	"rm *": "deny",
	"sudo *": "deny",
};

export const DEFAULT_PERMISSION_RULES: PermissionRules = {
	read: DEFAULT_READ_PERMISSION_RULES,
	edit: "allow",
	list: "allow",
	glob: "allow",
	grep: "allow",
	// Shell defaults to permissive allow with shipped `rm *`/`sudo *` denies
	// that users can override through config (ADR-0008).
	shell: DEFAULT_SHELL_PERMISSION_RULES,
	// Access outside the workspace is a visible boundary: it always requires
	// explicit approval unless a configured rule or remembered grant allows it.
	external_directory: "ask",
};

/**
 * Shipped per-Agent Permission restrictions applied at the defaults layer, below
 * every config source. Plan denies `edit`, which also hides the write and edit
 * tools, denies `shell`, which hides command execution, and denies every MCP
 * tool through the `*` action glob, until a valid higher policy explicitly
 * overrides either restriction.
 *
 * The `*` deny only reaches MCP tools: static coding-tool gating consults the
 * exact `STATIC_TOOL_PERMISSION_ACTIONS` keys and never honors an action glob, so
 * Plan keeps its read, glob, and grep tools while every discovered MCP tool
 * is denied unless a higher layer re-allows a specific logical name.
 */
export const SHIPPED_AGENT_PERMISSION_RULES: Readonly<
	Record<string, PermissionRules>
> = {
	plan: { edit: "deny", shell: "deny", "*": "deny" } as PermissionRules,
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

const stringGlobToRegExpSource = (pattern: string): string => {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index] as string;
		if (char === "*") {
			source += ".*";
			index += 1;
			continue;
		}
		if (char === "?") {
			source += ".";
			index += 1;
			continue;
		}
		source += escapeRegexChar(char);
		index += 1;
	}
	return source;
};

/**
 * Matches a pattern against a plain string resource (ADR-0008). `*` matches
 * any run of characters including `/`, so a deny like `rm *` catches
 * `rm src/index.ts`; `?` matches exactly one character. The whole string must
 * match and there is no directory-prefix widening — shell commands are not
 * file paths. The policy engine selects this matcher for the `shell` action
 * while file-path actions keep path-glob semantics.
 */
export function matchesStringPattern(
	pattern: string,
	resource: string
): boolean {
	return new RegExp(`^${stringGlobToRegExpSource(pattern)}$`).test(resource);
}

type ResourcePatternRule = { decision: PermissionDecision; pattern: string };

/** Selects the pattern matcher for an action: string globs for `shell`, path globs otherwise (ADR-0008). */
const matcherForAction = (
	action: PermissionAction
): ((pattern: string, resource: string) => boolean) =>
	action === "shell" ? matchesStringPattern : matchesResourcePattern;

/**
 * Applies a resource-map rule with last-matching-pattern-wins semantics.
 * Returns `fallback` when no pattern matches the resource, so a caller composing
 * across several action rules can pass the decision accumulated so far and a
 * non-matching map preserves it rather than silently loosening an earlier
 * explicit decision to `allow`.
 */
const decideByResourceMap = (
	entries: readonly ResourcePatternRule[],
	resource: string,
	fallback: PermissionDecision,
	matcher: (
		pattern: string,
		resource: string
	) => boolean = matchesResourcePattern
): PermissionDecision => {
	let decision = fallback;
	for (const entry of entries) {
		if (matcher(entry.pattern, resource)) {
			decision = entry.decision;
		}
	}
	return decision;
};

type NormalizedActionRule = PermissionDecision | readonly ResourcePatternRule[];

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
			// Expand `~` and `$HOME` once while compiling so external-directory
			// patterns are portable across user environments. Shell command
			// patterns are matched against raw command text, so they are never
			// home-expanded.
			pattern: action === "shell" ? pattern : expandHomeInPath(pattern),
		}));
	}
	return normalized;
};

/**
 * Builds a policy evaluator from fully resolved rules without seeding defaults.
 * A missing action falls back to `allow`, a scalar action applies to every
 * resource, and a resource map applies the last matching pattern's decision,
 * falling back to `allow` when nothing matches. `external_directory` is the
 * exception: its boundary default is `ask`, so a configured resource map that
 * matches nothing must not loosen the boundary — the ask default is preserved
 * for both missing actions and unmatched patterns.
 */
export function createResolvedToolPermission(
	rules: PermissionRules
): ToolPermission {
	const normalized = normalizeRules(rules);
	return {
		decide(action: PermissionAction, resource: string): PermissionDecision {
			const rule = normalized[action];
			if (rule === undefined) {
				return action === "external_directory" ? "ask" : "allow";
			}
			if (typeof rule === "string") {
				return rule;
			}
			return decideByResourceMap(
				rule,
				resource,
				action === "external_directory" ? "ask" : "allow",
				matcherForAction(action)
			);
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

/** Orders decisions from least to most restrictive: allow < ask < deny. */
const PERMISSION_DECISION_RANK: Record<PermissionDecision, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

/**
 * Composes two Permission decisions most-restrictively: a `deny` from either
 * side denies, otherwise an `ask` from either side asks, and only two allows
 * compose to an automatic allow. Used to combine an Agent's policy with the MCP
 * server's independent execution policy so neither source can loosen the other.
 */
export const composePermissionDecisions = (
	first: PermissionDecision,
	second: PermissionDecision
): PermissionDecision =>
	PERMISSION_DECISION_RANK[first] >= PERMISSION_DECISION_RANK[second]
		? first
		: second;

/**
 * Evaluates a policy for an open-glob action such as a logical MCP tool name,
 * where the action key itself is a `*`/`?` glob rather than a fixed coding-tool
 * action. Every action key is matched against the action as a glob and the last
 * matching key wins, mirroring the last-match-wins resource semantics. A scalar
 * action rule applies directly; a resource map applies its last matching pattern
 * for the resource. An action that matches no key falls back to `allow` so an
 * Agent with no MCP rules composes to the server policy unchanged.
 */
export const decideOpenActionPermission = (
	rules: PermissionRules,
	action: string,
	resource: string
): PermissionDecision => {
	let decision: PermissionDecision = "allow";
	for (const key of Object.keys(rules)) {
		if (!matchesResourcePattern(key, action)) {
			continue;
		}
		const rule = rules[key as PermissionAction];
		if (rule === undefined) {
			continue;
		}
		if (typeof rule === "string") {
			decision = rule;
			continue;
		}
		// Preserve the decision accumulated from earlier matching keys when this
		// map matches no resource pattern, so a later `demo_*: { "some/path": ... }`
		// rule can never silently bypass an earlier explicit `"*": "deny"`.
		decision = decideByResourceMap(
			Object.entries(rule).map(([pattern, patternDecision]) => ({
				decision: patternDecision,
				pattern,
			})),
			resource,
			decision
		);
	}
	return decision;
};
