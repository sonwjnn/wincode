import { describe, expect, test } from "bun:test";
import {
	applyManualApprovalSafetyCeiling,
	countFlattenedPermissionRules,
	createResolvedToolPermission,
	createToolPermission,
	DEFAULT_READ_PERMISSION_RULES,
	findUnmatchedActionKeys,
	foldPermissionRules,
	matchesResourcePattern,
	mergePermissionRules,
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
	test("routes the write tool through the edit action", () => {
		expect(STATIC_TOOL_PERMISSION_ACTIONS).toEqual({
			read: "read",
			write: "edit",
			edit: "edit",
			list: "list",
			grep: "grep",
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
	test("denies edit for Plan and stays empty for other agents", () => {
		expect(shippedAgentPermissionRules("plan")).toEqual({ edit: "deny" });
		expect(shippedAgentPermissionRules("build")).toEqual({});
		expect(shippedAgentPermissionRules("code-reviewer")).toEqual({});
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
			visible: ["read", "write", "edit", "list", "grep"],
		},
		{
			name: "hides write and edit when edit is unconditionally denied",
			rules: { edit: "deny" },
			visible: ["read", "list", "grep"],
		},
		{
			name: "hides only read when read is unconditionally denied",
			rules: { read: "deny" },
			visible: ["write", "edit", "list", "grep"],
		},
		{
			name: "keeps a granular edit map visible",
			rules: { edit: { "src/**": "deny" } },
			visible: ["read", "write", "edit", "list", "grep"],
		},
		{
			name: "keeps an ask-gated tool visible",
			rules: { list: "ask" },
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
