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
};

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
	write: "allow",
	edit: "allow",
	list: "allow",
	grep: "allow",
};

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
 * Builds the read policy evaluator, seeded with the Wincode defaults unless
 * rules are given. A missing action falls back to `allow`, a scalar action
 * applies to every resource, and a resource map applies the last matching
 * pattern's decision, falling back to `allow` when nothing matches.
 */
export function createToolPermission(
	rules: PermissionRules | undefined = DEFAULT_PERMISSION_RULES
): ToolPermission {
	const effectiveRules: PermissionRules = {
		...DEFAULT_PERMISSION_RULES,
		...rules,
		...(typeof rules?.read === "object"
			? {
					read: {
						...DEFAULT_READ_PERMISSION_RULES,
						...rules.read,
					},
				}
			: {}),
	};
	const normalized = normalizeRules(effectiveRules);
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
	};
}
