import { describe, expect, test } from "bun:test";
import type {
	ConfigDocument,
	ConfigSnapshot,
	ConfigSource,
} from "@/shared/config/config-store";
import { resolveAgentPermissionRules } from "./resolve";

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

describe("resolveAgentPermissionRules", () => {
	test("seeds defaults and shipped Agent restrictions with no sources", () => {
		const build = resolveAgentPermissionRules(snapshot([]), "build");
		expect(build.edit).toBe("allow");
		expect(build.read).toEqual({
			".env": "ask",
			".env.*": "ask",
			".env.example": "allow",
		});

		const plan = resolveAgentPermissionRules(snapshot([]), "plan");
		expect(plan.edit).toBe("deny");
	});

	test("a valid higher policy overrides the shipped Plan edit restriction", () => {
		const rules = resolveAgentPermissionRules(
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
		const rules = resolveAgentPermissionRules(
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
		const rules = resolveAgentPermissionRules(
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
		const rules = resolveAgentPermissionRules(
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
		const rules = resolveAgentPermissionRules(
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
		const rules = resolveAgentPermissionRules(
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
		const rules = resolveAgentPermissionRules(
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
