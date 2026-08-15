import { describe, expect, test } from "bun:test";
import {
	applyManualApprovalSafetyCeiling,
	composePermissionDecisions,
	countFlattenedPermissionRules,
	createResolvedToolPermission,
	createToolPermission,
	DEFAULT_READ_PERMISSION_RULES,
	decideOpenActionPermission,
	findUnmatchedActionKeys,
	foldPermissionRules,
	matchesResourcePattern,
	mergePermissionRules,
	type PermissionDecision,
	type PermissionRules,
	resolveVisibleCodingTools,
	STATIC_TOOL_PERMISSION_ACTIONS,
	shippedAgentPermissionRules,
} from "./policy";

describe("matchesResourcePattern", () => {
	test("matches exact and glob patterns at the workspace root", () => {
		expect(matchesResourcePattern(".env", ".env")).toBe(true);
		expect(matchesResourcePattern(".env.example", ".env.example")).toBe(true);
		expect(matchesResourcePattern(".env.*", ".env.production")).toBe(true);
		expect(matchesResourcePattern("*.env", "local.env")).toBe(true);
		expect(matchesResourcePattern("local.env", ".env")).toBe(false);
	});

	test("bare patterns match below any directory prefix", () => {
		expect(matchesResourcePattern(".env", "apps/api/.env")).toBe(true);
		expect(matchesResourcePattern(".env.*", "apps/api/.env.local")).toBe(true);
		expect(
			matchesResourcePattern(".env.example", "apps/api/.env.example")
		).toBe(true);
		expect(matchesResourcePattern("*.json", "apps/api/package.json")).toBe(
			true
		);
	});

	test("path patterns only match the full relative path", () => {
		expect(matchesResourcePattern("apps/api/*.ts", "apps/api/route.ts")).toBe(
			true
		);
		expect(matchesResourcePattern("apps/api/*.ts", "apps/route.ts")).toBe(
			false
		);
		expect(matchesResourcePattern("**/.env", "apps/api/.env")).toBe(true);
		expect(matchesResourcePattern("**/.env", ".env")).toBe(true);
	});

	test("? matches a single non-slash character", () => {
		expect(matchesResourcePattern("file?.txt", "file1.txt")).toBe(true);
		expect(matchesResourcePattern("file?.txt", "file12.txt")).toBe(false);
	});
});

describe("manual approval safety ceiling", () => {
	test("converts allows to asks while preserving asks and denies", () => {
		const permission = applyManualApprovalSafetyCeiling(
			createToolPermission({ read: "deny", write: "allow" })
		);

		expect(permission.decide("write", "src/app.ts")).toBe("ask");
		expect(permission.decide("list", ".")).toBe("ask");
		expect(permission.decide("read", ".env")).toBe("deny");
	});

	test("marks the evaluator as a safety ceiling and never returns an allow", () => {
		const ceiling = applyManualApprovalSafetyCeiling(
			createToolPermission({ edit: "allow", read: { ".env": "deny" } })
		);

		expect(ceiling.safety).toBe(true);
		// A preserved deny is never weakened into an automatic allow or ask.
		expect(ceiling.decide("read", ".env")).toBe("deny");
		// Every non-deny decision becomes a manual-only ask, never an allow.
		expect(ceiling.decide("edit", "src/app.ts")).toBe("ask");
		expect(ceiling.decide("list", ".")).toBe("ask");
	});

	test("an ordinary evaluator is not a safety ceiling", () => {
		expect(createToolPermission().safety).toBe(false);
		expect(createResolvedToolPermission({ edit: "deny" }).safety).toBe(false);
	});
});

describe("countFlattenedPermissionRules", () => {
	test("counts one per scalar action and one per resource-map pattern", () => {
		expect(
			countFlattenedPermissionRules({
				edit: "allow",
				list: "deny",
				read: { ".env": "ask", ".env.*": "ask", "**": "allow" },
			})
		).toBe(5);
	});

	test("counts nothing for an empty policy", () => {
		expect(countFlattenedPermissionRules({})).toBe(0);
	});
});

describe("findUnmatchedActionKeys", () => {
	test("flags action globs matching no known tool action", () => {
		expect(
			findUnmatchedActionKeys({
				edit: "allow",
				read: "allow",
				webfetch: "deny",
			} as unknown as PermissionRules)
		).toEqual(["webfetch"]);
	});

	test("treats a wildcard action key as matching every known action", () => {
		expect(
			findUnmatchedActionKeys({
				"*": "deny",
			} as unknown as PermissionRules)
		).toEqual([]);
	});

	test("matches against discovered tool actions when supplied", () => {
		expect(
			findUnmatchedActionKeys(
				{ github_search: "ask" } as unknown as PermissionRules,
				["read", "edit", "list", "grep", "github_search"]
			)
		).toEqual([]);
	});
});

describe("createToolPermission defaults", () => {
	const permission = createToolPermission();

	test("seeds .env and .env.* reads as ask", () => {
		expect(DEFAULT_READ_PERMISSION_RULES[".env"]).toBe("ask");
		expect(DEFAULT_READ_PERMISSION_RULES[".env.*"]).toBe("ask");
		expect(permission.decide("read", ".env")).toBe("ask");
		expect(permission.decide("read", ".env.production")).toBe("ask");
		expect(permission.decide("read", "apps/api/.env")).toBe("ask");
		expect(permission.decide("read", "apps/api/.env.local")).toBe("ask");
	});

	test("seeds .env.example and ordinary reads as allow", () => {
		expect(DEFAULT_READ_PERMISSION_RULES[".env.example"]).toBe("allow");
		expect(permission.decide("read", ".env.example")).toBe("allow");
		expect(permission.decide("read", "apps/api/.env.example")).toBe("allow");
		expect(permission.decide("read", "package.json")).toBe("allow");
		expect(permission.decide("read", "src/app.ts")).toBe("allow");
	});

	test("allows every action by default", () => {
		for (const action of ["write", "edit", "list", "grep"] as const) {
			expect(permission.decide(action, "anything")).toBe("allow");
		}
	});

	test("seeds shell execution as ask", () => {
		expect(permission.decide("shell", "bun test")).toBe("ask");
		expect(permission.decide("shell", "rm dist")).toBe("ask");
		expect(
			createToolPermission({ shell: "allow" }).decide("shell", "bun test")
		).toBe("allow");
	});
});

describe("createToolPermission configured rules", () => {
	test("a configured read map layers over the defaults", () => {
		const permission = createToolPermission({
			read: { ".env": "deny" },
		});
		expect(permission.decide("read", ".env")).toBe("deny");
		expect(permission.decide("read", ".env.local")).toBe("ask");
		expect(permission.decide("read", ".env.example")).toBe("allow");
		expect(permission.decide("read", "package.json")).toBe("allow");
	});

	test("an unrelated configured action retains the read defaults", () => {
		const permission = createToolPermission({ write: "deny" });
		expect(permission.decide("read", ".env.local")).toBe("ask");
	});

	test("a scalar action applies to every resource", () => {
		const permission = createToolPermission({ read: "ask" });
		expect(permission.decide("read", ".env")).toBe("ask");
		expect(permission.decide("read", "package.json")).toBe("ask");
	});

	test("the last matching rule wins", () => {
		const permission = createToolPermission({
			read: { ".env": "ask", "**": "allow" },
		});
		expect(permission.decide("read", ".env")).toBe("allow");
	});

	test("unmatched resources fall back to allow", () => {
		const permission = createToolPermission({
			read: { "src/*": "ask" },
		});
		expect(permission.decide("read", "src/app.ts")).toBe("ask");
		expect(permission.decide("read", "lib/app.ts")).toBe("allow");
	});

	test("unknown action keys stay inert", () => {
		const permission = createToolPermission({
			read: "allow",
			future: "deny",
		} as unknown as Parameters<typeof createToolPermission>[0]);
		expect(permission.decide("read", "x")).toBe("allow");
	});
});

describe("STATIC_TOOL_PERMISSION_ACTIONS", () => {
	test("routes the write tool through the edit action and shell through shell", () => {
		expect(STATIC_TOOL_PERMISSION_ACTIONS).toEqual({
			read: "read",
			write: "edit",
			edit: "edit",
			list: "list",
			grep: "grep",
			shell: "shell",
		});
	});
});

describe("mergePermissionRules", () => {
	test("object-to-object patches preserve ordered rules and append new ones", () => {
		const merged = mergePermissionRules(
			{ read: { ".env": "ask", ".env.example": "allow" } },
			{ read: { ".env.example": "deny", "src/*": "ask" } }
		);
		expect(Object.entries(merged.read as Record<string, string>)).toEqual([
			[".env", "ask"],
			[".env.example", "deny"],
			["src/*", "ask"],
		]);
	});

	test("scalar-to-object and object-to-scalar transitions replace the subtree", () => {
		expect(
			mergePermissionRules({ read: { ".env": "ask" } }, { read: "deny" })
		).toEqual({
			read: "deny",
		});
		expect(
			mergePermissionRules({ read: "deny" }, { read: { ".env": "ask" } })
		).toEqual({
			read: { ".env": "ask" },
		});
	});

	test("unaffected actions are retained", () => {
		expect(
			mergePermissionRules({ read: "ask", edit: "allow" }, { edit: "deny" })
		).toEqual({ read: "ask", edit: "deny" });
	});
});

describe("foldPermissionRules", () => {
	test("applies layers from lowest to highest precedence", () => {
		const folded = foldPermissionRules([
			{ edit: "allow", list: "allow" },
			{ edit: "deny" },
			{ list: "ask" },
		]);
		expect(folded).toEqual({ edit: "deny", list: "ask" });
	});
});

describe("shippedAgentPermissionRules", () => {
	test("denies edit, shell, and every open-glob action for Plan", () => {
		// The `*` deny is honored only by the MCP open-glob evaluator, so it makes
		// Plan's baseline expose no MCP tools while leaving static tool visibility
		// (which matches exact action keys) unchanged.
		expect(shippedAgentPermissionRules("plan")).toEqual({
			"*": "deny",
			edit: "deny",
			shell: "deny",
		} as PermissionRules);
		expect(shippedAgentPermissionRules("build")).toEqual({});
		expect(shippedAgentPermissionRules("code-reviewer")).toEqual({});
	});
});

describe("composePermissionDecisions", () => {
	test("takes the most-restrictive of the two decisions", () => {
		expect(composePermissionDecisions("allow", "allow")).toBe("allow");
		expect(composePermissionDecisions("allow", "ask")).toBe("ask");
		expect(composePermissionDecisions("ask", "allow")).toBe("ask");
		expect(composePermissionDecisions("ask", "ask")).toBe("ask");
		expect(composePermissionDecisions("allow", "deny")).toBe("deny");
		expect(composePermissionDecisions("deny", "allow")).toBe("deny");
		expect(composePermissionDecisions("ask", "deny")).toBe("deny");
		expect(composePermissionDecisions("deny", "ask")).toBe("deny");
		expect(composePermissionDecisions("deny", "deny")).toBe("deny");
	});
});

describe("decideOpenActionPermission", () => {
	// Open-glob keys (`*`, `demo_*`) sit outside the nominal PermissionAction
	// union, exactly like the shipped Plan rule; the evaluator matches them as
	// globs, so the tests cast the literals the same way the policy module does.
	const openRules = (
		rules: Record<
			string,
			PermissionDecision | Record<string, PermissionDecision>
		>
	): PermissionRules => rules as PermissionRules;

	test("falls back to allow when no key matches the action", () => {
		expect(decideOpenActionPermission({}, "demo_echo", "*")).toBe("allow");
		expect(decideOpenActionPermission({ edit: "deny" }, "demo_echo", "*")).toBe(
			"allow"
		);
	});

	test("matches a scalar action rule by glob", () => {
		expect(
			decideOpenActionPermission(openRules({ "*": "deny" }), "demo_echo", "*")
		).toBe("deny");
		expect(
			decideOpenActionPermission(
				openRules({ "demo_*": "ask" }),
				"demo_echo",
				"*"
			)
		).toBe("ask");
		expect(
			decideOpenActionPermission(
				openRules({ "demo_*": "ask" }),
				"other_echo",
				"*"
			)
		).toBe("allow");
	});

	test("lets the last matching key win", () => {
		expect(
			decideOpenActionPermission(
				openRules({ "*": "deny", "demo_*": "allow" }),
				"demo_echo",
				"*"
			)
		).toBe("allow");
		expect(
			decideOpenActionPermission(
				openRules({ "demo_*": "allow", "*": "deny" }),
				"demo_echo",
				"*"
			)
		).toBe("deny");
	});

	test("applies the last matching resource pattern for a map rule", () => {
		expect(
			decideOpenActionPermission(
				openRules({ "demo_*": { "*": "ask", secret: "deny" } }),
				"demo_echo",
				"secret"
			)
		).toBe("deny");
		expect(
			decideOpenActionPermission(
				openRules({ "demo_*": { "*": "ask", secret: "deny" } }),
				"demo_echo",
				"public"
			)
		).toBe("ask");
	});

	test("a non-matching map never loosens an earlier explicit deny", () => {
		// A later `demo_*` map whose patterns miss the resource must not reset an
		// earlier `"*": "deny"` back to allow — an explicit deny stays deny.
		expect(
			decideOpenActionPermission(
				openRules({ "*": "deny", "demo_*": { "some/path": "ask" } }),
				"demo_echo",
				"*"
			)
		).toBe("deny");
		// An explicit matching pattern may still override, honoring last-match-wins.
		expect(
			decideOpenActionPermission(
				openRules({ "*": "deny", "demo_*": { "*": "allow" } }),
				"demo_echo",
				"*"
			)
		).toBe("allow");
	});
});

describe("resolveVisibleCodingTools", () => {
	const cases: {
		name: string;
		rules: PermissionRules;
		visible: string[];
	}[] = [
		{
			name: "shows every tool with no denies",
			rules: { read: "allow", edit: "allow", list: "allow", grep: "allow" },
			visible: ["read", "write", "edit", "list", "grep", "shell"],
		},
		{
			name: "hides write and edit when edit is unconditionally denied",
			rules: { edit: "deny" },
			visible: ["read", "list", "grep", "shell"],
		},
		{
			name: "hides only read when read is unconditionally denied",
			rules: { read: "deny" },
			visible: ["write", "edit", "list", "grep", "shell"],
		},
		{
			name: "keeps a granular edit map visible",
			rules: { edit: { "src/**": "deny" } },
			visible: ["read", "write", "edit", "list", "grep", "shell"],
		},
		{
			name: "keeps an ask-gated tool visible",
			rules: { list: "ask" },
			visible: ["read", "write", "edit", "list", "grep", "shell"],
		},
		{
			name: "hides shell when the shell action is unconditionally denied",
			rules: { shell: "deny" },
			visible: ["read", "write", "edit", "list", "grep"],
		},
	];

	for (const { name, rules, visible } of cases) {
		test(name, () => {
			expect(resolveVisibleCodingTools(rules) as string[]).toEqual(visible);
		});
	}
});

describe("createResolvedToolPermission", () => {
	test("evaluates resolved rules without re-seeding defaults", () => {
		const permission = createResolvedToolPermission({ edit: "deny" });
		expect(permission.decide("edit", "src/app.ts")).toBe("deny");
		// No default read seeding: an unspecified action falls back to allow.
		expect(permission.decide("read", ".env")).toBe("allow");
	});
});
