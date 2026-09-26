import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverSkillCandidates,
	hasSkillNamespace,
	loadSkills,
	parseSkillFile,
	parseSkillInvocation,
} from "@/modules/skills";
import { createConfigStore } from "@/shared/config/config-store";

describe("skills", () => {
	test("parses and validates frontmatter", () => {
		const result = parseSkillFile(
			"---\nname: review\ndescription: Review code\ntags: [code, quality]\n---\n\nDo it."
		);
		expect(result.frontmatter.name).toBe("review");
		expect(result.frontmatter.tags).toEqual(["code", "quality"]);
		expect(result.body).toBe("\nDo it.");
	});

	test("rejects missing frontmatter", () => {
		expect(() => parseSkillFile("# review")).toThrow();
	});

	test("enforces OpenCode name and description limits", () => {
		expect(() =>
			parseSkillFile("---\nname: Bad_name\ndescription: ok\n---")
		).toThrow();
		expect(() =>
			parseSkillFile("---\nname: two--words\ndescription: ok\n---")
		).toThrow();
		expect(() =>
			parseSkillFile(`---\nname: ${"a".repeat(65)}\ndescription: ok\n---`)
		).toThrow();
		expect(() =>
			parseSkillFile("---\nname: valid\ndescription: \n---")
		).toThrow();
		expect(() =>
			parseSkillFile(`---\nname: valid\ndescription: ${"x".repeat(1025)}\n---`)
		).toThrow();
		expect(() =>
			parseSkillFile(
				`---\nname: valid\ndescription: ok\n---\n${"x".repeat(12_001)}`
			)
		).toThrow();
	});

	test("uses global and ancestor precedence deterministically", async () => {
		const root = join(tmpdir(), `discovery-${crypto.randomUUID()}`);
		const home = join(root, "home");
		const cwd = join(root, "packages", "app");
		await mkdir(join(root, ".git"), { recursive: true });
		for (const path of [
			join(home, ".agents", "skills", "same"),
			join(home, ".claude", "skills", "same"),
			join(home, ".config", "opencode", "skills", "same"),
			join(root, "packages", ".agents", "skills", "same"),
			join(cwd, ".claude", "skills", "same"),
		]) {
			await mkdir(path, { recursive: true });
			await Bun.write(
				join(path, "SKILL.md"),
				`---\nname: same\ndescription: ${path}\n---\nbody`
			);
		}
		const snapshot = await createConfigStore({
			homeRoot: home,
			xdgConfigHome: join(root, "xdg"),
		}).getSnapshot(cwd);
		const candidates = discoverSkillCandidates({
			homeRoot: home,
			snapshot,
			workspace: cwd,
		});
		const same = candidates.filter((candidate) =>
			candidate.filePath.endsWith("same/SKILL.md")
		);
		expect(same.map((candidate) => candidate.scope)).toEqual([
			"global",
			"global",
			"global",
			"project",
			"project",
		]);
		expect(
			(await loadSkills(candidates)).find((skill) => skill.name === "same")
				?.filePath
		).toBe(join(cwd, ".claude", "skills", "same", "SKILL.md"));
	});

	test("skips malformed, unreadable, and directory-mismatched skills", async () => {
		const root = join(tmpdir(), `skills-${crypto.randomUUID()}`);
		await mkdir(join(root, "good"), { recursive: true });
		await mkdir(join(root, "bad"), { recursive: true });
		await mkdir(join(root, "mismatch"), { recursive: true });
		await Bun.write(
			join(root, "good", "SKILL.md"),
			"---\nname: good\ndescription: Good\n---\nbody"
		);
		await Bun.write(join(root, "bad", "SKILL.md"), "not frontmatter");
		await Bun.write(
			join(root, "mismatch", "SKILL.md"),
			"---\nname: other\ndescription: Bad\n---\nbody"
		);
		const skills = await loadSkills([
			{
				filePath: join(root, "good", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
			{
				filePath: join(root, "bad", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
			{
				filePath: join(root, "missing", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
			{
				filePath: join(root, "mismatch", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
		]);
		expect(skills.map((skill) => skill.name)).toEqual(["good"]);
	});

	test("parses namespaced slash invocation arguments", () => {
		expect(parseSkillInvocation("/skill:review focus on auth")).toEqual({
			name: "review",
			arguments: "focus on auth",
		});
		expect(parseSkillInvocation("/skill:review")).toEqual({
			name: "review",
			arguments: "",
		});
		expect(parseSkillInvocation("/review focus on auth")).toBeNull();
		expect(parseSkillInvocation("/skill: review")).toBeNull();
		expect(parseSkillInvocation("plain text")).toBeNull();
	});

	test("recognizes the reserved namespace even when the name is malformed", () => {
		expect(hasSkillNamespace("/skill:review")).toBe(true);
		expect(hasSkillNamespace("  /SKILL:")).toBe(true);
		expect(hasSkillNamespace("/skills")).toBe(false);
		expect(hasSkillNamespace("/review")).toBe(false);
	});
});
