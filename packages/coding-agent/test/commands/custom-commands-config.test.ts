import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getCustomCommands } from "@/modules/commands/custom/loader";
import { createConfigStore } from "@/shared/config/config-store";
import { writeFixture } from "@/test/support/filesystem";

describe("configured Custom Commands", () => {
	test("loads an absolute global path without overriding project commands", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-global-commands-")
		);
		const homeRoot = path.join(root, "home");
		const workspace = path.join(root, "workspace");
		const globalCommands = path.join(root, "shared-commands");

		try {
			await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
			await Promise.all([
				writeFixture(
					path.join(homeRoot, ".wincode", "settings.json"),
					JSON.stringify({ commands: { paths: [globalCommands] } })
				),
				writeFixture(
					path.join(globalCommands, "global-only.md"),
					"---\ndescription: Global configured\n---\nGlobal configured template."
				),
				writeFixture(
					path.join(globalCommands, "review.md"),
					"---\ndescription: Global review\n---\nGlobal review template."
				),
				writeFixture(
					path.join(workspace, ".wincode", "commands", "review.md"),
					"---\ndescription: Project review\n---\nProject review template."
				),
			]);

			const configStore = createConfigStore({ homeRoot });
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
			await fs.rm(root, { force: true, recursive: true });
		}
	});

	test("loads conventional and configured folders through Wincode config", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-commands-"));
		const homeRoot = path.join(root, "home");
		const repository = path.join(root, "repository");
		const workspace = path.join(repository, "packages", "app");

		try {
			await fs.mkdir(path.join(repository, ".git"), { recursive: true });
			await Promise.all([
				writeFixture(
					path.join(homeRoot, ".wincode", "commands", "global.md"),
					"---\ndescription: Global command\n---\nGlobal template."
				),
				writeFixture(
					path.join(repository, ".wincode", "commands", "ancestor.md"),
					"---\ndescription: Ancestor command\n---\nAncestor template."
				),
				writeFixture(
					path.join(workspace, ".wincode", "commands", "review.md"),
					"---\ndescription: Conventional command\n---\nConventional template."
				),
				writeFixture(
					path.join(workspace, ".wincode", "configured-commands", "review.md"),
					"---\ndescription: Configured command\n---\nConfigured template."
				),
				writeFixture(
					path.join(workspace, ".wincode", "settings.jsonc"),
					'{\n  // Paths are relative to this config file.\n  "commands": { "paths": ["configured-commands"], },\n}'
				),
			]);

			const configStore = createConfigStore({
				homeRoot,
				trustedProjectRoots: [workspace],
			});
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
			await fs.rm(root, { force: true, recursive: true });
		}
	});
});
