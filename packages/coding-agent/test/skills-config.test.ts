import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillRootDescriptors, discoverSkills } from "@/modules/skills";
import { createConfigStore } from "@/shared/config/config-store";
import { writeFixture } from "@/test/support/filesystem";

const skillFile = (name: string, description: string): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n${description} instructions.`;

describe("configured Skills", () => {
	test("loads an absolute path from global config with global scope", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-global-skills-")
		);
		const homeRoot = path.join(root, "home");
		const workspace = path.join(root, "workspace");
		const globalSkills = path.join(root, "shared-skills");

		try {
			await Promise.all([
				writeFixture(
					path.join(homeRoot, ".wincode", "settings.json"),
					JSON.stringify({ skills: { paths: [globalSkills] } })
				),
				writeFixture(
					path.join(globalSkills, "global-configured", "SKILL.md"),
					skillFile("global-configured", "Global configured")
				),
			]);

			const configStore = createConfigStore({ homeRoot });
			const snapshot = await configStore.getSnapshot(workspace);
			const descriptors = buildSkillRootDescriptors({
				homeRoot,
				snapshot,
				workspace,
			});
			const configured = descriptors.filter(
				({ path }) => path === globalSkills
			);
			expect(configured).toMatchObject([
				{
					scope: "global",
					source: "configured",
				},
			]);
			expect(descriptors.map(({ precedence }) => precedence)).toEqual(
				descriptors.map((_, index) => index)
			);
			const skills = await discoverSkills({
				configStore,
				homeRoot,
				workspace,
			});

			expect(skills).toMatchObject([
				{
					description: "Global configured",
					name: "global-configured",
					scope: "global",
				},
			]);
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});

	test("prefers the home Wincode folder and ignores the obsolete XDG Wincode folder", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-skill-precedence-")
		);
		const homeRoot = path.join(root, "home");
		const workspace = path.join(root, "workspace");
		const xdgConfigHome = path.join(root, "xdg");

		try {
			await Promise.all([
				writeFixture(
					path.join(
						homeRoot,
						".config",
						"opencode",
						"skills",
						"review",
						"SKILL.md"
					),
					skillFile("review", "Legacy global")
				),
				writeFixture(
					path.join(homeRoot, ".wincode", "skills", "review", "SKILL.md"),
					skillFile("review", "Wincode global")
				),
				writeFixture(
					path.join(xdgConfigHome, "wincode", "skills", "review", "SKILL.md"),
					skillFile("review", "Wincode XDG")
				),
				writeFixture(
					path.join(xdgConfigHome, "wincode", "skills", "xdg-only", "SKILL.md"),
					skillFile("xdg-only", "Wincode XDG only")
				),
			]);

			const configStore = createConfigStore({ homeRoot });
			const skills = await discoverSkills({
				configStore,
				homeRoot,
				workspace,
			});

			expect(skills.map(({ name }) => name)).toEqual(["review"]);
			expect(skills.find(({ name }) => name === "review")?.description).toBe(
				"Wincode global"
			);
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});

	test("loads legacy, Wincode, and configured folders through Wincode config", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-skills-"));
		const homeRoot = path.join(root, "home");
		const repository = path.join(root, "repository");
		const workspace = path.join(repository, "packages", "app");

		try {
			await fs.mkdir(path.join(repository, ".git"), { recursive: true });
			await Promise.all([
				writeFixture(
					path.join(homeRoot, ".agents", "skills", "legacy", "SKILL.md"),
					skillFile("legacy", "Legacy global")
				),
				writeFixture(
					path.join(
						homeRoot,
						".wincode",
						"skills",
						"global-wincode",
						"SKILL.md"
					),
					skillFile("global-wincode", "Wincode global")
				),
				writeFixture(
					path.join(repository, ".wincode", "skills", "ancestor", "SKILL.md"),
					skillFile("ancestor", "Wincode ancestor")
				),
				writeFixture(
					path.join(workspace, ".wincode", "skills", "review", "SKILL.md"),
					skillFile("review", "Conventional project")
				),
				writeFixture(
					path.join(
						workspace,
						".wincode",
						"first-skills",
						"review",
						"SKILL.md"
					),
					skillFile("review", "First configured project")
				),
				writeFixture(
					path.join(
						workspace,
						".wincode",
						"second-skills",
						"review",
						"SKILL.md"
					),
					skillFile("review", "Second configured project")
				),
				writeFixture(
					path.join(workspace, ".wincode", "settings.json"),
					JSON.stringify({
						skills: { paths: ["first-skills", "second-skills"] },
					})
				),
			]);

			const configStore = createConfigStore({
				homeRoot,
				trustedProjectRoots: [workspace],
			});
			const snapshot = await configStore.getSnapshot(workspace);
			const configured = buildSkillRootDescriptors({
				homeRoot,
				snapshot,
				workspace,
			}).filter(({ source }) => source === "configured");
			expect(configured.slice(-2)).toMatchObject([
				{
					path: path.join(workspace, ".wincode", "first-skills"),
					scope: "project",
					source: "configured",
				},
				{
					path: path.join(workspace, ".wincode", "second-skills"),
					scope: "project",
					source: "configured",
				},
			]);
			const skills = await discoverSkills({
				configStore,
				homeRoot,
				workspace,
			});

			expect(skills.map(({ name }) => name)).toEqual([
				"ancestor",
				"global-wincode",
				"legacy",
				"review",
			]);
			expect(skills.find(({ name }) => name === "review")).toMatchObject({
				body: "Second configured project instructions.",
				description: "Second configured project",
				scope: "project",
			});
		} finally {
			await fs.rm(root, { force: true, recursive: true });
		}
	});
});
