import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-skills-fs-")
		);
		const low = path.join(directory, "low");
		const high = path.join(directory, "high");
		try {
			await Promise.all([
				fs.mkdir(path.join(low, "review"), { recursive: true }),
				fs.mkdir(path.join(high, "review"), { recursive: true }),
			]);
			await Promise.all([
				Bun.write(
					path.join(low, "review", "SKILL.md"),
					skillFile("review", "low")
				),
				Bun.write(
					path.join(high, "review", "SKILL.md"),
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
			await fs.rm(directory, { force: true, recursive: true });
		}
	});
	test("reuses unchanged files and refreshes changed metadata", async () => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-skills-cache-")
		);
		const skillDirectory = path.join(directory, "review");
		const skillPath = path.join(skillDirectory, "SKILL.md");
		try {
			await fs.mkdir(skillDirectory, { recursive: true });
			await Bun.write(skillPath, skillFile("review", "first"));
			const roots = [root(directory, 1)];
			const [first] = await discoverFilesystemSkills(roots);
			const [cached] = await discoverFilesystemSkills(roots);
			expect(cached).toBe(first);

			await Bun.write(skillPath, skillFile("review", "updated"));
			const [updated] = await discoverFilesystemSkills(roots);
			expect(updated).not.toBe(cached);
			expect(updated?.description).toBe("updated");
		} finally {
			await fs.rm(directory, { force: true, recursive: true });
		}
	});

	test("skips malformed and directory-mismatched files", async () => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-skills-invalid-")
		);
		try {
			await Promise.all([
				fs.mkdir(path.join(directory, "good"), { recursive: true }),
				fs.mkdir(path.join(directory, "bad"), { recursive: true }),
				fs.mkdir(path.join(directory, "mismatch"), { recursive: true }),
				fs.mkdir(path.join(directory, "fallback-low", "fallback"), {
					recursive: true,
				}),
				fs.mkdir(path.join(directory, "fallback-high", "fallback"), {
					recursive: true,
				}),
			]);
			await Promise.all([
				Bun.write(
					path.join(directory, "good", "SKILL.md"),
					skillFile("good", "Good")
				),
				Bun.write(path.join(directory, "bad", "SKILL.md"), "not frontmatter"),
				Bun.write(
					path.join(directory, "mismatch", "SKILL.md"),
					skillFile("other", "Bad")
				),
				Bun.write(
					path.join(directory, "fallback-low", "fallback", "SKILL.md"),
					skillFile("fallback", "Fallback")
				),
				Bun.write(
					path.join(directory, "fallback-high", "fallback", "SKILL.md"),
					"not frontmatter"
				),
			]);
			const skills = await discoverFilesystemSkills([
				root(path.join(directory, "fallback-high"), 20),
				root(path.join(directory, "fallback-low"), 10),
				root(directory, 1),
			]);
			expect(skills.map(({ name }) => name)).toEqual(["fallback", "good"]);
			expect(skills[0]?.description).toBe("Fallback");
		} finally {
			await fs.rm(directory, { force: true, recursive: true });
		}
	});

	test("samples bounded direct resources deterministically", async () => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-skills-resource-")
		);
		try {
			await Promise.all([
				Bun.write(path.join(directory, "SKILL.md"), "body"),
				Bun.write(path.join(directory, "z.txt"), "z"),
				Bun.write(path.join(directory, "a.txt"), "a"),
				fs.mkdir(path.join(directory, "nested")),
			]);
			expect(await sampleSkillResources(directory)).toEqual([
				path.join(directory, "a.txt"),
				path.join(directory, "nested"),
				path.join(directory, "z.txt"),
			]);
		} finally {
			await fs.rm(directory, { force: true, recursive: true });
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
