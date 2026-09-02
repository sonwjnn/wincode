import { describe, expect, test } from "bun:test";
import { hashSkillBody } from "./filesystem";
import {
	buildSkillCatalog,
	buildSkillToolDefinition,
	createSkillExecution,
	createSkillSnapshot,
	MAX_ACTIVE_SKILLS,
	sanitizeSkillToolResult,
} from "./index";
import type { Skill } from "./types";

const skill = (name: string, overrides: Partial<Skill> = {}): Skill => ({
	body: `body-${name}`,
	description: `description-${name}`,
	filePath: `/skills/${name}/SKILL.md`,
	name,
	scope: "project",
	...overrides,
});

const allowAll = () => () => "allow" as const;

describe("buildSkillCatalog", () => {
	test("includes permitted skills sorted by name", () => {
		const catalog = buildSkillCatalog(
			[skill("zeta"), skill("alpha")],
			allowAll()
		);
		expect(catalog.entries.map(({ name }) => name)).toEqual(["alpha", "zeta"]);
		expect(catalog.toolEnabled).toBe(true);
		expect(catalog.diagnostics).toEqual([]);
	});

	test("hides denied skills without diagnostics", () => {
		const catalog = buildSkillCatalog(
			[skill("public"), skill("internal")],
			(name) => (name === "internal" ? "deny" : "allow")
		);
		expect(catalog.entries.map(({ name }) => name)).toEqual(["public"]);
		expect(catalog.diagnostics).toEqual([]);
	});

	test("omits invalid skills with diagnostics instead of truncating", () => {
		const catalog = buildSkillCatalog(
			[
				skill("fine"),
				skill("long-name", { name: "a".repeat(65) }),
				skill("long-description", { description: "d".repeat(1025) }),
				skill("long-body", { body: "b".repeat(12_001) }),
			],
			allowAll()
		);
		expect(catalog.entries.map(({ name }) => name)).toEqual(["fine"]);
		expect(
			catalog.diagnostics.map(({ code, skillName }) => ({ code, skillName }))
		).toEqual([
			{ code: "invalid-skill", skillName: "a".repeat(65) },
			{ code: "invalid-skill", skillName: "long-description" },
			{ code: "invalid-skill", skillName: "long-body" },
		]);
	});

	test("disables the tool when the catalog exceeds its total budget", () => {
		const manySkills = Array.from({ length: 100 }, (_, index) =>
			skill(`skill-${String(index).padStart(3, "0")}`, {
				description: "d".repeat(1024),
			})
		);
		const catalog = buildSkillCatalog(manySkills, allowAll());
		expect(catalog.toolEnabled).toBe(false);
		expect(catalog.diagnostics.map(({ code }) => code)).toEqual([
			"catalog-over-budget",
		]);
		expect(buildSkillToolDefinition(catalog)).toBeUndefined();
	});

	test("builds a dynamic tool definition only when entries exist", () => {
		const definition = buildSkillToolDefinition(
			buildSkillCatalog([skill("review")], allowAll())
		);
		expect(definition?.name).toBe("skill");
		expect(definition?.description).toContain("<available_skills>");
		expect(definition?.description).toContain("- review: description-review");
		expect(definition?.inputSchema.required).toEqual(["name"]);
		expect(
			buildSkillToolDefinition(buildSkillCatalog([], allowAll()))
		).toBeUndefined();
	});
	test("derives catalog hashes from the body", () => {
		const catalog = buildSkillCatalog(
			[skill("review", { contentHash: "stale-hash" })],
			allowAll()
		);
		expect(catalog.entries[0]?.contentHash).toBe(hashSkillBody("body-review"));
	});
});
describe("createSkillSnapshot", () => {
	test("hashes body instructions and records activation source", () => {
		expect(
			createSkillSnapshot(
				{
					arguments: "focus",
					instructions: "Review carefully.",
					name: "review",
				},
				"explicit"
			)
		).toEqual({
			arguments: "focus",
			contentHash: hashSkillBody("Review carefully."),
			instructions: "Review carefully.",
			name: "review",
			source: "explicit",
		});
	});
});

describe("createSkillExecution", () => {
	const catalog = buildSkillCatalog(
		[skill("review"), skill("lint"), skill("commit"), skill("extra")],
		allowAll()
	);

	test("loads a Skill with a body snapshot and content hash", () => {
		const execution = createSkillExecution(catalog);
		const result = execution.activate("review", "agent");
		expect(result.status).toBe("loaded");
		if (result.status !== "loaded") {
			throw new Error("expected loaded");
		}
		expect(result.snapshot).toMatchObject({
			baseDirectory: "/skills/review",
			body: "body-review",
			contentHash: hashSkillBody("body-review"),
			name: "review",
			source: "agent",
		});
		expect(execution.activeSnapshots()).toHaveLength(1);
	});

	test("re-loading an active Skill is idempotent and consumes no slot", () => {
		const execution = createSkillExecution(catalog);
		execution.activate("review", "agent");
		const again = execution.activate("review", "agent");
		expect(again).toEqual({
			contentHash: hashSkillBody("body-review"),
			name: "review",
			status: "already-loaded",
		});
		expect(execution.activeSnapshots()).toHaveLength(1);
	});

	test("allows at most three distinct Skills and rejects a fourth without replacing", () => {
		const execution = createSkillExecution(catalog);
		for (const name of ["review", "lint", "commit"]) {
			expect(execution.activate(name, "agent").status).toBe("loaded");
		}
		const fourth = execution.activate("extra", "agent");
		expect(fourth).toEqual({
			activeSkillNames: ["review", "lint", "commit"],
			limit: MAX_ACTIVE_SKILLS,
			name: "extra",
			status: "limit-reached",
		});
		expect(execution.activeSnapshots().map(({ name }) => name)).toEqual([
			"review",
			"lint",
			"commit",
		]);
	});

	test("rejected names short-circuit without consuming a slot", () => {
		const execution = createSkillExecution(catalog);
		execution.markRejected("review");
		expect(execution.activate("review", "agent")).toEqual({
			name: "review",
			status: "rejected",
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
	});

	test("fails unknown names without consuming a slot", () => {
		const execution = createSkillExecution(catalog);
		expect(execution.activate("missing", "agent")).toEqual({
			error: 'Unknown Skill "missing"',
			name: "missing",
			status: "failed",
		});
		expect(execution.activeSnapshots()).toHaveLength(0);
	});

	test("explicit activation shares the same slot budget", () => {
		const execution = createSkillExecution(catalog);
		execution.activate("review", "explicit");
		expect(execution.activate("lint", "agent").status).toBe("loaded");
		expect(execution.activate("commit", "agent").status).toBe("loaded");
		expect(execution.activate("extra", "agent").status).toBe("limit-reached");
	});
});

describe("sanitizeSkillToolResult", () => {
	test("keeps only activation metadata for loaded results", () => {
		const result = sanitizeSkillToolResult({
			baseDirectory: "/skills/review",
			body: "secret body",
			contentHash: "hash",
			name: "review",
			resourcePaths: ["/skills/review/a.txt"],
			source: "agent",
			status: "loaded",
		});
		expect(result).toEqual({
			contentHash: "hash",
			name: "review",
			source: "agent",
			status: "loaded",
		});
		expect(JSON.stringify(result)).not.toContain("secret body");
		expect(JSON.stringify(result)).not.toContain("skills/review");
	});

	test("passes through every non-loaded status unchanged", () => {
		expect(sanitizeSkillToolResult({ name: "x", status: "rejected" })).toEqual({
			name: "x",
			status: "rejected",
		});
		expect(
			sanitizeSkillToolResult({ error: "boom", name: "x", status: "failed" })
		).toEqual({ error: "boom", name: "x", status: "failed" });
		expect(
			sanitizeSkillToolResult({
				activeSkillNames: ["a"],
				limit: 3,
				name: "x",
				status: "limit-reached",
			})
		).toEqual({
			activeSkillNames: ["a"],
			limit: 3,
			name: "x",
			status: "limit-reached",
		});
	});
});

describe("catalog entry shape", () => {
	test("carries base directory and body for activation", () => {
		const catalog = buildSkillCatalog([skill("review")], allowAll());
		const entry = catalog.entries[0];
		expect(entry).toMatchObject({
			baseDirectory: "/skills/review",
			body: "body-review",
			contentHash: hashSkillBody("body-review"),
			filePath: "/skills/review/SKILL.md",
		});
	});
});
