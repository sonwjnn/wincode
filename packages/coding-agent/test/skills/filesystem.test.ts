import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillRootDescriptor } from "@/modules/skills";
import {
	discoverFilesystemSkillCandidates,
	discoverFilesystemSkills,
	hashSkillBody,
	sampleSkillResources,
} from "@/modules/skills";

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
				globalThis.Bun.write(
					join(low, "review", "SKILL.md"),
					skillFile("review", "low")
				),
				globalThis.Bun.write(
					join(high, "review", "SKILL.md"),
					skillFile("review", "high")
				),
			]);
			const roots = [root(high, 20), root(low, 10)];

			const candidates = discoverFilesystemSkillCandidates(roots);
			expect(candidates.map(({ precedence }) => precedence)).toEqual([10, 20]);
			expect(candidates[0]).toMatchObject({
				root: low,
				scope: "project",
				source: "configured",
			});

			const skills = await discoverFilesystemSkills(roots);
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
			await globalThis.Bun.write(skillPath, skillFile("review", "first"));
			const roots = [root(directory, 1)];
			const [first] = await discoverFilesystemSkills(roots);
			const [cached] = await discoverFilesystemSkills(roots);
			expect(cached).toBe(first);

			await globalThis.Bun.write(skillPath, skillFile("review", "updated"));
			const [updated] = await discoverFilesystemSkills(roots);
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
				globalThis.Bun.write(
					join(directory, "good", "SKILL.md"),
					skillFile("good", "Good")
				),
				globalThis.Bun.write(
					join(directory, "bad", "SKILL.md"),
					"not frontmatter"
				),
				globalThis.Bun.write(
					join(directory, "mismatch", "SKILL.md"),
					skillFile("other", "Bad")
				),
				globalThis.Bun.write(
					join(directory, "fallback-low", "fallback", "SKILL.md"),
					skillFile("fallback", "Fallback")
				),
				globalThis.Bun.write(
					join(directory, "fallback-high", "fallback", "SKILL.md"),
					"not frontmatter"
				),
			]);
			const skills = await discoverFilesystemSkills([
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
				globalThis.Bun.write(join(directory, "SKILL.md"), "body"),
				globalThis.Bun.write(join(directory, "z.txt"), "z"),
				globalThis.Bun.write(join(directory, "a.txt"), "a"),
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

	test("hashes UTF-8 content with SHA-256", async () => {
		for (const body of ["", "abc", "skills 💾".repeat(200)]) {
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(body)
			);
			expect(hashSkillBody(body)).toBe(
				Array.from(new Uint8Array(digest), (byte) =>
					byte.toString(16).padStart(2, "0")
				).join("")
			);
		}
	});
});
