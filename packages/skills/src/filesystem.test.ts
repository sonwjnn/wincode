import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillRootDescriptor } from "./filesystem";
import {
	discoverSkillCandidates,
	discoverSkills,
	hashSkillBody,
	sampleSkillResources,
} from "./filesystem";

const skillFile = (name: string, description: string): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n${description} instructions.`;

const root = (
	path: string,
	precedence: number,
	source = "configured"
): SkillRootDescriptor => ({
	path,
	precedence,
	scope: "project",
	source,
});

describe("Skill filesystem export", () => {
	test("discovers explicit roots and applies numeric precedence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-skills-fs-"));
		const low = join(directory, "low");
		const high = join(directory, "high");
		try {
			await Promise.all([
				mkdir(join(low, "review"), { recursive: true }),
				mkdir(join(high, "review"), { recursive: true }),
			]);
			await Promise.all([
				writeFile(join(low, "review", "SKILL.md"), skillFile("review", "low")),
				writeFile(
					join(high, "review", "SKILL.md"),
					skillFile("review", "high")
				),
			]);
			const roots = [root(high, 20), root(low, 10)];

			const candidates = discoverSkillCandidates(roots);
			expect(candidates.map(({ precedence }) => precedence)).toEqual([10, 20]);
			expect(candidates[0]).toMatchObject({
				root: low,
				scope: "project",
				source: "configured",
			});

			const skills = await discoverSkills(roots);
			expect(skills).toMatchObject([
				{
					contentHash: hashSkillBody("high instructions."),
					description: "high",
					name: "review",
					precedence: 20,
				},
			]);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
	test("reuses unchanged files and refreshes changed metadata", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-skills-cache-"));
		const skillDirectory = join(directory, "review");
		const skillPath = join(skillDirectory, "SKILL.md");
		try {
			await mkdir(skillDirectory, { recursive: true });
			await writeFile(skillPath, skillFile("review", "first"));
			const roots = [root(directory, 1)];
			const [first] = await discoverSkills(roots);
			const [cached] = await discoverSkills(roots);
			expect(cached).toBe(first);

			await writeFile(skillPath, skillFile("review", "updated"));
			const [updated] = await discoverSkills(roots);
			expect(updated).not.toBe(cached);
			expect(updated?.description).toBe("updated");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("skips malformed and directory-mismatched files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-skills-invalid-"));
		try {
			await Promise.all([
				mkdir(join(directory, "good"), { recursive: true }),
				mkdir(join(directory, "bad"), { recursive: true }),
				mkdir(join(directory, "mismatch"), { recursive: true }),
				mkdir(join(directory, "fallback-low", "fallback"), {
					recursive: true,
				}),
				mkdir(join(directory, "fallback-high", "fallback"), {
					recursive: true,
				}),
			]);
			await Promise.all([
				writeFile(
					join(directory, "good", "SKILL.md"),
					skillFile("good", "Good")
				),
				writeFile(join(directory, "bad", "SKILL.md"), "not frontmatter"),
				writeFile(
					join(directory, "mismatch", "SKILL.md"),
					skillFile("other", "Bad")
				),
				writeFile(
					join(directory, "fallback-low", "fallback", "SKILL.md"),
					skillFile("fallback", "Fallback")
				),
				writeFile(
					join(directory, "fallback-high", "fallback", "SKILL.md"),
					"not frontmatter"
				),
			]);
			const skills = await discoverSkills([
				root(join(directory, "fallback-high"), 20),
				root(join(directory, "fallback-low"), 10),
				root(directory, 1),
			]);
			expect(skills.map(({ name }) => name)).toEqual(["fallback", "good"]);
			expect(skills[0]?.description).toBe("Fallback");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("samples bounded direct resources deterministically", async () => {
		const directory = await mkdtemp(join(tmpdir(), "wincode-skills-resource-"));
		try {
			await Promise.all([
				writeFile(join(directory, "SKILL.md"), "body"),
				writeFile(join(directory, "z.txt"), "z"),
				writeFile(join(directory, "a.txt"), "a"),
				mkdir(join(directory, "nested")),
			]);
			expect(await sampleSkillResources(directory)).toEqual([
				join(directory, "a.txt"),
				join(directory, "nested"),
				join(directory, "z.txt"),
			]);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("hashes UTF-8 content with SHA-256", () => {
		for (const body of ["", "abc", "skills 💾".repeat(200)]) {
			expect(hashSkillBody(body)).toBe(
				createHash("sha256").update(body).digest("hex")
			);
		}
	});
});
