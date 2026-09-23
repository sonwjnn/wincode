import { type CodingToolName, codingToolNames } from "@wincode/coding-tools";
import { isPlainObject, isString, isUndefined } from "@wincode/runtime-utils";
import { expandHomeInPath } from "./external-directory";

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionAction =
	| "read"
	| "write"
	| "edit"
	| "edit:sloppy"
	| "list"
	| "glob"
	| "grep"
	| "shell"
	| "recover"
	| "recover:cross-session"
	| "recover:discard"
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
	 * Effective rules when the evaluator can expose them to composition code.
	 * Resource-aware prompt descriptions use this to distinguish a deny at an
	 * empty probe from a deny that applies to every resource.
	 */
	readonly rules?: PermissionRules;
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
	"edit:sloppy",
	"list",
	"glob",
	"grep",
	"recover",
	"recover:cross-session",
	"recover:discard",
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
	recover: "recover",
} as const satisfies Record<CodingToolName, PermissionAction>;

/** Tightens every non-denied decision to an approval that must be handled manually. */
export function applyManualApprovalSafetyCeiling(
	permission: ToolPermission
): ToolPermission {
	return {
		decide(action, resource) {
			return permission.decide(action, resource) === "deny" ? "deny" : "ask";
		},
		rules: permission.rules,
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
	"edit:sloppy": "ask",
	list: "allow",
	glob: "allow",
	grep: "allow",
	// Shell defaults to permissive allow with shipped `rm *`/`sudo *` denies
	// that users can override through config (ADR-0008).
	shell: DEFAULT_SHELL_PERMISSION_RULES,
	recover: "ask",
	"recover:cross-session": "ask",
	"recover:discard": "ask",
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
): value is PermissionResourceRules => isPlainObject(value);

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
		if (isUndefined(incoming)) {
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
				source += "[\\s\\S]*";
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
		return new RegExp(`^(?:${source})$(?![\\s\\S])`).test(resource);
	}
	return new RegExp(`^(?:[^/]+/)*${source}$(?![\\s\\S])`).test(resource);
}

const stringGlobToRegExpSource = (pattern: string): string => {
	let source = "";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index] as string;
		if (char === "*") {
			source += "[\\s\\S]*";
			index += 1;
			continue;
		}
		if (char === "?") {
			source += "[\\s\\S]";
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
	return new RegExp(
		`^(?:${stringGlobToRegExpSource(pattern)})$(?![\\s\\S])`
	).test(resource);
}

type ResourcePatternRule = { decision: PermissionDecision; pattern: string };
const normalizeResourceRules = (
	action: PermissionAction,
	rule: PermissionResourceRules
): ResourcePatternRule[] =>
	Object.entries(rule).map(([pattern, decision]) => ({
		decision,
		// Expand `~` and `$HOME` once while compiling so external-directory
		// patterns are portable across user environments. Shell command
		// patterns are matched against raw command text, so they are never
		// home-expanded.
		pattern: action === "shell" ? pattern : expandHomeInPath(pattern),
	}));

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
		if (isString(rule)) {
			normalized[action] = rule;
			continue;
		}
		if (isUndefined(rule)) {
			continue;
		}
		normalized[action] = normalizeResourceRules(action, rule);
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
			if (isUndefined(rule)) {
				return action === "external_directory" ? "ask" : "allow";
			}
			if (isString(rule)) {
				return rule;
			}
			return decideByResourceMap(
				rule,
				resource,
				action === "external_directory" ? "ask" : "allow",
				matcherForAction(action)
			);
		},
		rules,
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

const PATH_GLOB_CHARS = /^[*?/]+$/u;
const WILDCARD_GLOB_CHARS = /^[*?]+$/u;

const isUniversalNonEmptyGlob = (pattern: string): boolean =>
	WILDCARD_GLOB_CHARS.test(pattern) &&
	pattern.includes("*") &&
	pattern.replaceAll("*", "").length <= 1;

const isUniversalPathPattern = (pattern: string): boolean => {
	if (!PATH_GLOB_CHARS.test(pattern) || pattern.endsWith("/")) {
		return false;
	}
	if (!pattern.includes("/")) {
		return isUniversalNonEmptyGlob(pattern);
	}
	return pattern.startsWith("**/") && isUniversalPathPattern(pattern.slice(3));
};

const isUniversalResourcePattern = (
	pattern: string,
	action: PermissionAction
): boolean =>
	action === "shell"
		? isUniversalNonEmptyGlob(pattern)
		: isUniversalPathPattern(pattern);

type GlobTransitionKind = "any" | "literal" | "nonSlash";
type GlobTransition = {
	readonly kind: GlobTransitionKind;
	readonly to: number;
	readonly value?: string;
};
type GlobAutomaton = {
	readonly accepts: ReadonlySet<number>;
	readonly epsilon: readonly (readonly number[])[];
	readonly start: number;
	readonly transitions: readonly (readonly GlobTransition[])[];
};
type MutableGlobAutomaton = {
	accepts: Set<number>;
	epsilon: number[][];
	start: number;
	transitions: GlobTransition[][];
};

const MAX_GLOB_AUTOMATON_STATES = 8192;
const MAX_GLOB_ANALYSIS_STATES = 4096;
const MAX_GLOB_ANALYSIS_TRANSITIONS = 1_000_000;
const MAX_GLOB_ALPHABET = 1024;
const NON_DENY_DECISIONS = ["allow", "ask"] as const;

const addGlobState = (automaton: MutableGlobAutomaton): number | undefined => {
	if (automaton.epsilon.length >= MAX_GLOB_AUTOMATON_STATES) {
		return;
	}
	automaton.epsilon.push([]);
	automaton.transitions.push([]);
	return automaton.epsilon.length - 1;
};

const addGlobEpsilon = (
	automaton: MutableGlobAutomaton,
	from: number,
	to: number
): void => {
	automaton.epsilon[from]?.push(to);
};

const addGlobTransition = (
	automaton: MutableGlobAutomaton,
	from: number,
	transition: GlobTransition
): void => {
	automaton.transitions[from]?.push(transition);
};
const globWildcardLength = (
	isSegmentDoubleStar: boolean,
	isDoubleStar: boolean
): number => {
	if (isSegmentDoubleStar) {
		return 3;
	}
	return isDoubleStar ? 2 : 1;
};

const compileGlobStar = (
	automaton: MutableGlobAutomaton,
	current: number,
	action: PermissionAction,
	isDoubleStar: boolean
): number | undefined => {
	const after = addGlobState(automaton);
	if (isUndefined(after)) {
		return;
	}
	addGlobEpsilon(automaton, current, after);
	addGlobTransition(automaton, current, {
		kind: action === "shell" || isDoubleStar ? "any" : "nonSlash",
		to: current,
	});
	return after;
};

const compileGlobSegmentDoubleStar = (
	automaton: MutableGlobAutomaton,
	current: number
): number | undefined => {
	const after = addGlobState(automaton);
	const inside = addGlobState(automaton);
	if (isUndefined(after) || isUndefined(inside)) {
		return;
	}
	addGlobEpsilon(automaton, current, after);
	addGlobTransition(automaton, current, {
		kind: "nonSlash",
		to: inside,
	});
	addGlobTransition(automaton, inside, {
		kind: "nonSlash",
		to: inside,
	});
	addGlobTransition(automaton, inside, {
		kind: "literal",
		to: current,
		value: "/",
	});
	return after;
};

const compileGlobCharacter = (
	automaton: MutableGlobAutomaton,
	current: number,
	character: string,
	action: PermissionAction
): number | undefined => {
	const after = addGlobState(automaton);
	if (isUndefined(after)) {
		return;
	}
	if (character === "?") {
		addGlobTransition(automaton, current, {
			kind: action === "shell" ? "any" : "nonSlash",
			to: after,
		});
	} else {
		addGlobTransition(automaton, current, {
			kind: "literal",
			to: after,
			value: character,
		});
	}
	return after;
};

const compileGlobPattern = (
	pattern: string,
	action: PermissionAction
): GlobAutomaton | undefined => {
	const effectivePattern =
		action === "shell" || pattern.includes("/") ? pattern : `**/${pattern}`;
	// Match the runtime regexes' UTF-16 code-unit semantics.
	const patternCharacters = effectivePattern;
	const automaton: MutableGlobAutomaton = {
		accepts: new Set(),
		epsilon: [[]],
		start: 0,
		transitions: [[]],
	};
	let current = automaton.start;
	let index = 0;
	while (index < patternCharacters.length) {
		const character = patternCharacters[index];
		if (isUndefined(character)) {
			return;
		}
		if (character === "*") {
			const isDoubleStar = patternCharacters[index + 1] === "*";
			const isSegmentDoubleStar =
				action !== "shell" &&
				isDoubleStar &&
				patternCharacters[index + 2] === "/";
			const next = isSegmentDoubleStar
				? compileGlobSegmentDoubleStar(automaton, current)
				: compileGlobStar(automaton, current, action, isDoubleStar);
			if (isUndefined(next)) {
				return;
			}
			current = next;
			index += globWildcardLength(isSegmentDoubleStar, isDoubleStar);
			continue;
		}
		const next = compileGlobCharacter(automaton, current, character, action);
		if (isUndefined(next)) {
			return;
		}
		current = next;
		index += 1;
	}
	automaton.accepts.add(current);
	return automaton;
};

const createGlobUnionAutomaton = (
	patterns: readonly string[],
	action: PermissionAction
): GlobAutomaton | undefined => {
	const automaton: MutableGlobAutomaton = {
		accepts: new Set(),
		epsilon: [[]],
		start: 0,
		transitions: [[]],
	};
	for (const pattern of patterns) {
		const compiled = compileGlobPattern(pattern, action);
		if (
			isUndefined(compiled) ||
			automaton.epsilon.length + compiled.epsilon.length >
				MAX_GLOB_AUTOMATON_STATES
		) {
			return;
		}
		const offset = automaton.epsilon.length;
		for (const _ of compiled.epsilon) {
			automaton.epsilon.push([]);
			automaton.transitions.push([]);
		}
		addGlobEpsilon(automaton, automaton.start, offset + compiled.start);
		for (const [index, epsilonEdges] of compiled.epsilon.entries()) {
			for (const target of epsilonEdges) {
				addGlobEpsilon(automaton, offset + index, offset + target);
			}
			for (const transition of compiled.transitions[index] ?? []) {
				addGlobTransition(automaton, offset + index, {
					...transition,
					to: offset + transition.to,
				});
			}
		}
		for (const accept of compiled.accepts) {
			automaton.accepts.add(offset + accept);
		}
	}
	return automaton;
};

const epsilonClosure = (
	automaton: GlobAutomaton,
	initial: Iterable<number>
): number[] => {
	const closure = new Set(initial);
	const pending = [...closure];
	while (pending.length > 0) {
		const state = pending.pop();
		if (isUndefined(state)) {
			continue;
		}
		for (const next of automaton.epsilon[state] ?? []) {
			if (!closure.has(next)) {
				closure.add(next);
				pending.push(next);
			}
		}
	}
	return [...closure].sort((first, second) => first - second);
};

const matchesGlobTransition = (
	transition: GlobTransition,
	character: string
): boolean => {
	switch (transition.kind) {
		case "literal":
			return transition.value === character;
		case "nonSlash":
			return character !== "/";
		case "any":
			return true;
		default:
			return false;
	}
};

const stepGlob = (
	automaton: GlobAutomaton,
	states: readonly number[],
	character: string
): number[] => {
	const next = new Set<number>();
	for (const state of states) {
		for (const transition of automaton.transitions[state] ?? []) {
			if (matchesGlobTransition(transition, character)) {
				next.add(transition.to);
			}
		}
	}
	return epsilonClosure(automaton, next);
};

const globAccepts = (
	automaton: GlobAutomaton,
	states: readonly number[]
): boolean => states.some((state) => automaton.accepts.has(state));

const freshGlobCharacter = (
	characters: ReadonlySet<string>,
	predicate: (character: string) => boolean
): string => {
	for (let code = 0; code <= 0xff_ff; code += 1) {
		const character = String.fromCharCode(code);
		if (!characters.has(character) && predicate(character)) {
			return character;
		}
	}
	return "\u0000";
};

const globAlphabet = (
	patterns: readonly string[]
): readonly string[] | undefined => {
	const characters = new Set(["/", "\n", "\r", "\u2028", "\u2029"]);
	for (const pattern of patterns) {
		// The runtime regexes are non-Unicode, so wildcards consume UTF-16 code units.
		for (const character of pattern.split("")) {
			characters.add(character);
			if (characters.size > MAX_GLOB_ALPHABET) {
				return;
			}
		}
	}
	characters.add(
		freshGlobCharacter(characters, (character) => character !== "/")
	);
	if (characters.size > MAX_GLOB_ALPHABET) {
		return;
	}
	return [...characters];
};
type GlobProductState = {
	readonly blockerStates: readonly number[];
	readonly consumed: boolean;
	readonly targetStates: readonly number[];
};

const globProductKey = (state: GlobProductState): string =>
	`${state.consumed ? "1" : "0"}|${state.targetStates.join(",")}|${state.blockerStates.join(",")}`;
const nextGlobProductStates = (
	state: GlobProductState,
	alphabet: readonly string[],
	target: GlobAutomaton,
	blockers: GlobAutomaton
): GlobProductState[] => {
	const nextStates: GlobProductState[] = [];
	for (const character of alphabet) {
		const targetStates = stepGlob(target, state.targetStates, character);
		if (targetStates.length === 0) {
			continue;
		}
		nextStates.push({
			blockerStates: stepGlob(blockers, state.blockerStates, character),
			consumed: true,
			targetStates,
		});
	}
	return nextStates;
};

const hasGlobLanguageDifference = (
	targetPattern: string,
	blockedPatterns: readonly string[],
	action: PermissionAction
): boolean | undefined => {
	const target = compileGlobPattern(targetPattern, action);
	const blockers = createGlobUnionAutomaton(blockedPatterns, action);
	if (isUndefined(target) || isUndefined(blockers)) {
		return;
	}
	const alphabet = globAlphabet([targetPattern, ...blockedPatterns]);
	if (isUndefined(alphabet)) {
		return;
	}
	const queue: GlobProductState[] = [
		{
			blockerStates: epsilonClosure(blockers, [blockers.start]),
			consumed: false,
			targetStates: epsilonClosure(target, [target.start]),
		},
	];
	const visited = new Set<string>();
	let queueIndex = 0;
	let transitionCount = 0;
	while (queueIndex < queue.length) {
		const state = queue[queueIndex];
		queueIndex += 1;
		if (isUndefined(state)) {
			continue;
		}
		const key = globProductKey(state);
		if (visited.has(key)) {
			continue;
		}
		visited.add(key);
		if (visited.size > MAX_GLOB_ANALYSIS_STATES) {
			return;
		}
		if (
			state.consumed &&
			globAccepts(target, state.targetStates) &&
			!globAccepts(blockers, state.blockerStates)
		) {
			return true;
		}
		if (transitionCount + alphabet.length > MAX_GLOB_ANALYSIS_TRANSITIONS) {
			return;
		}
		transitionCount += alphabet.length;
		for (const nextState of nextGlobProductStates(
			state,
			alphabet,
			target,
			blockers
		)) {
			queue.push(nextState);
		}
	}
	return false;
};

const hasEffectiveResourceDecision = (
	entries: readonly ResourcePatternRule[],
	action: PermissionAction,
	decisions: readonly PermissionDecision[],
	minimumIndex: number
): boolean | undefined => {
	for (const [index, entry] of entries.entries()) {
		if (
			index <= minimumIndex ||
			entry.pattern.length === 0 ||
			!decisions.includes(entry.decision)
		) {
			continue;
		}
		const difference = hasGlobLanguageDifference(
			entry.pattern,
			entries.slice(index + 1).map(({ pattern }) => pattern),
			action
		);
		if (difference === true) {
			return true;
		}
		if (isUndefined(difference)) {
			return;
		}
	}
	return false;
};

/**
 * Hides a resource map only when its final non-deny language is empty. An
 * analysis limit fails open for visibility so a usable resource is not hidden.
 */
const isUniversalResourceDeny = (
	rule: PermissionResourceRules,
	action: PermissionAction
): boolean => {
	const entries = normalizeResourceRules(action, rule);
	const universalDenyIndex = entries.findLastIndex(
		({ pattern, decision }) =>
			decision === "deny" && isUniversalResourcePattern(pattern, action)
	);
	if (universalDenyIndex < 0) {
		return false;
	}
	return (
		hasEffectiveResourceDecision(
			entries,
			action,
			NON_DENY_DECISIONS,
			universalDenyIndex
		) === false
	);
};

const hasEffectiveResourceAsk = (
	action: PermissionAction,
	rule: PermissionResourceRules
): boolean => {
	const entries = normalizeResourceRules(action, rule);
	const result = hasEffectiveResourceDecision(entries, action, ["ask"], -1);
	// If bounded analysis cannot decide, retain the approval signal rather than
	// silently describing a possibly approval-gated resource as allowed.
	return result === true || isUndefined(result);
};

/**
 * Describes a visible tool from its policy without treating an empty resource
 * probe as an unconditional deny. Resource maps with any allowed or approval-
 * gated resource stay visible; an all-denied map remains omitted.
 */
export const describeVisibleToolPermission = (
	permission: ToolPermission,
	action: PermissionAction
): PermissionDecision => {
	const rule = permission.rules?.[action];
	if (!isResourceMap(rule)) {
		return permission.decide(action, "");
	}
	if (isUniversalResourceDeny(rule, action)) {
		return "deny";
	}
	const decision = permission.decide(action, "");
	if (permission.safety || hasEffectiveResourceAsk(action, rule)) {
		return "ask";
	}
	return decision === "deny" ? "allow" : decision;
};

/**
 * A static tool is hidden from the model when its governing action is an
 * unconditional scalar deny or a catch-all resource deny. Other granular
 * resource maps and ask scalars keep the tool visible for per-resource gating.
 */
export const isStaticToolUnconditionallyDenied = (
	rules: PermissionRules,
	tool: CodingToolName
): boolean => {
	const rule = rules[STATIC_TOOL_PERMISSION_ACTIONS[tool]];
	const action = STATIC_TOOL_PERMISSION_ACTIONS[tool];
	return (
		rule === "deny" ||
		(isResourceMap(rule) && isUniversalResourceDeny(rule, action))
	);
};
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
		if (isUndefined(rule)) {
			continue;
		}
		count += isString(rule) ? 1 : Object.keys(rule).length;
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
		if (isUndefined(rule)) {
			continue;
		}
		if (isString(rule)) {
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
