import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "@/shared/config/config-store";
import { writeFixture } from "@/shared/config/filesystem-test-utils";
import { buildSkillRootDescriptors } from "./discovery";
import { discoverSkills } from "./index";

const skillFile = (name: string, description: string): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n${description} instructions.`;

describe("configured Skills", () => {
	test("loads an absolute path from global config with global scope", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-global-skills-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");
		const globalSkills = join(root, "shared-skills");

		try {
			await Promise.all([
				writeFixture(
					join(xdgConfigHome, "wincode", "wincode.json"),
					JSON.stringify({ skills: { paths: [globalSkills] } })
				),
				writeFixture(
					join(globalSkills, "global-configured", "SKILL.md"),
					skillFile("global-configured", "Global configured")
				),
			]);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
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
			await rm(root, { force: true, recursive: true });
		}
	});

	test("prefers the Wincode folder over legacy folders in the global scope", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-skill-precedence-"));
		const homeRoot = join(root, "home");
		const workspace = join(root, "workspace");
		const xdgConfigHome = join(root, "xdg");

		try {
			await Promise.all([
				writeFixture(
					join(homeRoot, ".config", "opencode", "skills", "review", "SKILL.md"),
					skillFile("review", "Legacy global")
				),
				writeFixture(
					join(homeRoot, ".wincode", "skills", "review", "SKILL.md"),
					skillFile("review", "Wincode global")
				),
				writeFixture(
					join(xdgConfigHome, "wincode", "skills", "review", "SKILL.md"),
					skillFile("review", "Wincode XDG")
				),
				writeFixture(
					join(xdgConfigHome, "wincode", "skills", "xdg-only", "SKILL.md"),
					skillFile("xdg-only", "Wincode XDG only")
				),
			]);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const skills = await discoverSkills({
				configStore,
				homeRoot,
				workspace,
			});

			expect(skills.map(({ name }) => name)).toEqual(["review", "xdg-only"]);
			expect(skills.find(({ name }) => name === "review")?.description).toBe(
				"Wincode global"
			);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("loads legacy, Wincode, and configured folders through Wincode config", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-skills-"));
		const homeRoot = join(root, "home");
		const xdgConfigHome = join(root, "xdg");
		const repository = join(root, "repository");
		const workspace = join(repository, "packages", "app");

		try {
			await mkdir(join(repository, ".git"), { recursive: true });
			await Promise.all([
				writeFixture(
					join(homeRoot, ".agents", "skills", "legacy", "SKILL.md"),
					skillFile("legacy", "Legacy global")
				),
				writeFixture(
					join(homeRoot, ".wincode", "skills", "global-wincode", "SKILL.md"),
					skillFile("global-wincode", "Wincode global")
				),
				writeFixture(
					join(repository, ".wincode", "skills", "ancestor", "SKILL.md"),
					skillFile("ancestor", "Wincode ancestor")
				),
				writeFixture(
					join(workspace, ".wincode", "skills", "review", "SKILL.md"),
					skillFile("review", "Conventional project")
				),
				writeFixture(
					join(workspace, ".wincode", "first-skills", "review", "SKILL.md"),
					skillFile("review", "First configured project")
				),
				writeFixture(
					join(workspace, ".wincode", "second-skills", "review", "SKILL.md"),
					skillFile("review", "Second configured project")
				),
				writeFixture(
					join(workspace, ".wincode", "wincode.json"),
					JSON.stringify({
						skills: { paths: ["first-skills", "second-skills"] },
					})
				),
			]);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const snapshot = await configStore.getSnapshot(workspace);
			const configured = buildSkillRootDescriptors({
				homeRoot,
				snapshot,
				workspace,
			}).filter(({ source }) => source === "configured");
			expect(configured.slice(-2)).toMatchObject([
				{
					path: join(workspace, ".wincode", "first-skills"),
					scope: "project",
					source: "configured",
				},
				{
					path: join(workspace, ".wincode", "second-skills"),
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
			await rm(root, { force: true, recursive: true });
		}
	});
});
