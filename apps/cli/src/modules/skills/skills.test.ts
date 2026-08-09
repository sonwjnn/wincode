import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "@/shared/config/config-store";
import { discoverSkillCandidates } from "./discovery";
import { parseSkillFile } from "./frontmatter";
import { parseSkillInvocation } from "./invocation";
import { loadSkills } from "./loader";

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
			await writeFile(
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
		await writeFile(
			join(root, "good", "SKILL.md"),
			"---\nname: good\ndescription: Good\n---\nbody"
		);
		await writeFile(join(root, "bad", "SKILL.md"), "not frontmatter");
		await writeFile(
			join(root, "mismatch", "SKILL.md"),
			"---\nname: other\ndescription: Bad\n---\nbody"
		);
		const skills = await loadSkills([
			{ filePath: join(root, "good", "SKILL.md"), root, scope: "project" },
			{ filePath: join(root, "bad", "SKILL.md"), root, scope: "project" },
			{ filePath: join(root, "missing", "SKILL.md"), root, scope: "project" },
			{ filePath: join(root, "mismatch", "SKILL.md"), root, scope: "project" },
		]);
		expect(skills.map((skill) => skill.name)).toEqual(["good"]);
	});

	test("parses slash invocation arguments", () => {
		expect(parseSkillInvocation("/review focus on auth")).toEqual({
			name: "review",
			arguments: "focus on auth",
		});
		expect(parseSkillInvocation("plain text")).toBeNull();
	});
});
