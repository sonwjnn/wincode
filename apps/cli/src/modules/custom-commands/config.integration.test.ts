import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "@/shared/config/config-store";
import { writeFixture } from "@/shared/config/filesystem-test-utils";
import { getCustomCommands } from "./loader";

describe("configured Custom Commands", () => {
	test("loads an absolute global path without overriding project commands", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-global-commands-"));
		const homeRoot = join(root, "home");
		const xdgConfigHome = join(root, "xdg");
		const workspace = join(root, "workspace");
		const globalCommands = join(root, "shared-commands");

		try {
			await mkdir(join(workspace, ".git"), { recursive: true });
			await Promise.all([
				writeFixture(
					join(xdgConfigHome, "wincode", "wincode.json"),
					JSON.stringify({ commands: { paths: [globalCommands] } })
				),
				writeFixture(
					join(globalCommands, "global-only.md"),
					"---\ndescription: Global configured\n---\nGlobal configured template."
				),
				writeFixture(
					join(globalCommands, "review.md"),
					"---\ndescription: Global review\n---\nGlobal review template."
				),
				writeFixture(
					join(workspace, ".wincode", "commands", "review.md"),
					"---\ndescription: Project review\n---\nProject review template."
				),
			]);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const commands = await getCustomCommands({
				configStore,
				homeRoot,
				workspace,
			});

			expect(commands.map(({ name }) => name)).toEqual([
				"global-only",
				"review",
			]);
			expect(commands.find(({ name }) => name === "review")?.description).toBe(
				"Project review"
			);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("loads conventional and configured folders through Wincode config", async () => {
		const root = await mkdtemp(join(tmpdir(), "wincode-commands-"));
		const homeRoot = join(root, "home");
		const xdgConfigHome = join(root, "xdg");
		const repository = join(root, "repository");
		const workspace = join(repository, "packages", "app");

		try {
			await mkdir(join(repository, ".git"), { recursive: true });
			await Promise.all([
				writeFixture(
					join(homeRoot, ".wincode", "commands", "global.md"),
					"---\ndescription: Global command\n---\nGlobal template."
				),
				writeFixture(
					join(repository, ".wincode", "commands", "ancestor.md"),
					"---\ndescription: Ancestor command\n---\nAncestor template."
				),
				writeFixture(
					join(workspace, ".wincode", "commands", "review.md"),
					"---\ndescription: Conventional command\n---\nConventional template."
				),
				writeFixture(
					join(workspace, ".wincode", "configured-commands", "review.md"),
					"---\ndescription: Configured command\n---\nConfigured template."
				),
				writeFixture(
					join(workspace, ".wincode", "wincode.jsonc"),
					'{\n  // Paths are relative to this config file.\n  "commands": { "paths": ["configured-commands"], },\n}'
				),
			]);

			const configStore = createConfigStore({ homeRoot, xdgConfigHome });
			const commands = await getCustomCommands({
				configStore,
				homeRoot,
				workspace,
			});

			expect(commands.map(({ name }) => name)).toEqual([
				"ancestor",
				"global",
				"review",
			]);
			expect(commands.find(({ name }) => name === "review")).toMatchObject({
				description: "Configured command",
				template: "Configured template.",
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
