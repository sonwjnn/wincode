import { describe, expect, test } from "bun:test";
import type {
	ConfigDocument,
	ConfigSnapshot,
	ConfigSource,
} from "@/shared/config/config-store";
import { MAX_FLATTENED_PERMISSION_RULES, type PermissionRules } from "./policy";
import { resolveAgentPermission } from "./resolve";

// The effective folded rules are the common assertion target; resolve them
// directly so each ordering/precedence test reads only the rule it exercises.
const resolveRules = (snap: ConfigSnapshot, agentId: string): PermissionRules =>
	resolveAgentPermission(snap, agentId).rules;

const source = (
	path: string,
	document: Record<string, unknown>
): ConfigSource => ({
	document: document as ConfigDocument,
	path,
	scope: path.includes(".config") ? "global" : "project",
});

const snapshot = (sources: ConfigSource[]): ConfigSnapshot => ({
	diagnostics: [],
	document: {} as ConfigDocument,
	sourceFor: () => undefined,
	sources,
});

describe("resolveAgentPermission effective rules", () => {
	test("seeds defaults and shipped Agent restrictions with no sources", () => {
		const build = resolveRules(snapshot([]), "build");
		expect(build.edit).toBe("allow");
		expect(build.read).toEqual({
			".env": "ask",
			".env.*": "ask",
			".env.example": "allow",
		});

		const plan = resolveRules(snapshot([]), "plan");
		expect(plan.edit).toBe("deny");
	});

	test("a valid higher policy overrides the shipped Plan edit restriction", () => {
		const rules = resolveRules(
			snapshot([
				source("/w/wincode.json", {
					agents: { plan: { permission: { edit: "allow" } } },
				}),
			]),
			"plan"
		);
		expect(rules.edit).toBe("allow");
	});

	test("higher precedence sources win over lower ones", () => {
		const rules = resolveRules(
			snapshot([
				source("/home/.config/wincode/wincode.json", {
					permission: { edit: "deny" },
				}),
				source("/w/wincode.json", { permission: { edit: "allow" } }),
			]),
			"build"
		);
		expect(rules.edit).toBe("allow");
	});

	test("within one source the Agent policy applies after the top-level policy", () => {
		const rules = resolveRules(
			snapshot([
				source("/w/wincode.json", {
					agents: { build: { permission: { edit: "allow" } } },
					permission: { edit: "deny" },
				}),
			]),
			"build"
		);
		expect(rules.edit).toBe("allow");
	});

	test("a project-wide rule overrides a global Agent rule", () => {
		const rules = resolveRules(
			snapshot([
				source("/home/.config/wincode/wincode.json", {
					agents: { build: { permission: { list: "deny" } } },
				}),
				source("/w/wincode.json", { permission: { list: "allow" } }),
			]),
			"build"
		);
		expect(rules.list).toBe("allow");
	});

	test("a project Agent rule overrides a project-wide rule", () => {
		const rules = resolveRules(
			snapshot([
				source("/w/wincode.json", {
					agents: { build: { permission: { list: "deny" } } },
					permission: { list: "allow" },
				}),
			]),
			"build"
		);
		expect(rules.list).toBe("deny");
	});

	test("object and scalar transitions follow the replacement contract", () => {
		const rules = resolveRules(
			snapshot([
				source("/home/.config/wincode/wincode.json", {
					permission: { read: { ".env.example": "deny" } },
				}),
				source("/w/wincode.json", { permission: { read: "allow" } }),
			]),
			"build"
		);
		expect(rules.read).toBe("allow");
	});

	test("malformed permission subtrees are skipped so lower precedence rules stay", () => {
		const rules = resolveRules(
			snapshot([
				source("/home/.config/wincode/wincode.json", {
					permission: { edit: "deny" },
				}),
				source("/w/wincode.json", {
					agents: { build: { permission: { edit: "banana" } } },
					permission: "not-an-object",
				}),
			]),
			"build"
		);
		expect(rules.edit).toBe("deny");
	});
});

describe("resolveAgentPermission safety ceiling", () => {
	test("valid policy resolves with no ceiling and no diagnostics", () => {
		const resolved = resolveAgentPermission(
			snapshot([source("/w/wincode.json", { permission: { edit: "deny" } })]),
			"build"
		);
		expect(resolved.safetyCeiling).toBe(false);
		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.rules.edit).toBe("deny");
	});

	test("malformed top-level policy raises the ceiling without permissive fallback", () => {
		const resolved = resolveAgentPermission(
			snapshot([
				source("/home/.config/wincode/wincode.json", {
					permission: { edit: "deny" },
				}),
				source("/w/wincode.json", { permission: "not-an-object" }),
			]),
			"build"
		);
		expect(resolved.safetyCeiling).toBe(true);
		// The preserved deny from the lower source survives; the malformed source
		// contributes nothing and does not restore a permissive default.
		expect(resolved.rules.edit).toBe("deny");
		expect(resolved.diagnostics).toMatchObject([
			{
				code: "invalid-permission-policy",
				configPath: ["permission"],
				origin: { path: "/w/wincode.json", scope: "project" },
				severity: "error",
			},
		]);
	});

	test("a malformed low-precedence policy still latches the ceiling under a valid higher policy", () => {
		const resolved = resolveAgentPermission(
			snapshot([
				source("/home/.config/wincode/wincode.json", {
					permission: "not-an-object",
				}),
				source("/w/wincode.json", { permission: { edit: "deny" } }),
			]),
			"build"
		);
		// The ceiling latches on the malformed global source and is never cleared
		// by the valid project source; the valid layer's deny is still folded in.
		expect(resolved.safetyCeiling).toBe(true);
		expect(resolved.rules.edit).toBe("deny");
		expect(resolved.diagnostics).toMatchObject([
			{
				code: "invalid-permission-policy",
				origin: { path: "/home/.config/wincode/wincode.json", scope: "global" },
				severity: "error",
			},
		]);
	});

	test("a malformed top-level policy cannot alter rule order or drop a lower deny", () => {
		const resolved = resolveAgentPermission(
			snapshot([
				source("/home/.config/wincode/wincode.json", {
					permission: { list: { "src/**": "deny", "**": "allow" } },
				}),
				source("/w/wincode.json", { permission: { list: 42 } }),
			]),
			"build"
		);
		expect(resolved.safetyCeiling).toBe(true);
		// Partial parsing of the malformed higher source must not reorder or
		// override the lower source's ordered rules.
		expect(
			Object.entries(resolved.rules.list as Record<string, string>)
		).toEqual([
			["src/**", "deny"],
			["**", "allow"],
		]);
	});

	test("an effective policy over the flattened-rule limit raises the ceiling", () => {
		const patterns: Record<string, string> = {};
		for (let index = 0; index <= MAX_FLATTENED_PERMISSION_RULES; index += 1) {
			patterns[`src/file-${index}.ts`] = "allow";
		}
		const resolved = resolveAgentPermission(
			snapshot([source("/w/wincode.json", { permission: { read: patterns } })]),
			"build"
		);
		expect(resolved.safetyCeiling).toBe(true);
		expect(resolved.diagnostics).toMatchObject([
			{ code: "permission-rule-limit", severity: "error" },
		]);
	});

	test("an action glob matching no known tool stays active with a warning", () => {
		const resolved = resolveAgentPermission(
			snapshot([
				source("/w/wincode.json", { permission: { webfetch: "deny" } }),
			]),
			"build"
		);
		expect(resolved.safetyCeiling).toBe(false);
		// The unmatched action is retained in the effective policy.
		expect((resolved.rules as Record<string, unknown>).webfetch).toBe("deny");
		expect(resolved.diagnostics).toMatchObject([
			{
				code: "unmatched-permission-action",
				configPath: ["permission", "webfetch"],
				severity: "warning",
			},
		]);
	});

	test("the shipped defaults raise no unmatched-action warnings", () => {
		const resolved = resolveAgentPermission(snapshot([]), "build");
		expect(resolved.diagnostics).toEqual([]);
		expect(resolved.safetyCeiling).toBe(false);
	});
});
