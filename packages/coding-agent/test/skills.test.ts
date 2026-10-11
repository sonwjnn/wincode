import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverSkillCandidates,
	loadSkills,
	parseSkillFile,
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
		const root = path.join(os.tmpdir(), `discovery-${crypto.randomUUID()}`);
		const home = path.join(root, "home");
		const cwd = path.join(root, "packages", "app");
		await fs.mkdir(path.join(root, ".git"), { recursive: true });
		for (const skillDirectory of [
			path.join(home, ".agents", "skills", "same"),
			path.join(home, ".claude", "skills", "same"),
			path.join(home, ".config", "opencode", "skills", "same"),
			path.join(root, "packages", ".agents", "skills", "same"),
			path.join(cwd, ".claude", "skills", "same"),
		]) {
			await fs.mkdir(skillDirectory, { recursive: true });
			await Bun.write(
				path.join(skillDirectory, "SKILL.md"),
				`---\nname: same\ndescription: ${skillDirectory}\n---\nbody`
			);
		}
		const snapshot = await createConfigStore({
			homeRoot: home,
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
		).toBe(path.join(cwd, ".claude", "skills", "same", "SKILL.md"));
	});

	test("skips malformed, unreadable, and directory-mismatched skills", async () => {
		const root = path.join(os.tmpdir(), `skills-${crypto.randomUUID()}`);
		await fs.mkdir(path.join(root, "good"), { recursive: true });
		await fs.mkdir(path.join(root, "bad"), { recursive: true });
		await fs.mkdir(path.join(root, "mismatch"), { recursive: true });
		await Bun.write(
			path.join(root, "good", "SKILL.md"),
			"---\nname: good\ndescription: Good\n---\nbody"
		);
		await Bun.write(path.join(root, "bad", "SKILL.md"), "not frontmatter");
		await Bun.write(
			path.join(root, "mismatch", "SKILL.md"),
			"---\nname: other\ndescription: Bad\n---\nbody"
		);
		const skills = await loadSkills([
			{
				filePath: path.join(root, "good", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
			{
				filePath: path.join(root, "bad", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
			{
				filePath: path.join(root, "missing", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
			{
				filePath: path.join(root, "mismatch", "SKILL.md"),
				precedence: 0,
				root,
				scope: "project",
				source: "test",
			},
		]);
		expect(skills.map((skill) => skill.name)).toEqual(["good"]);
	});
});
