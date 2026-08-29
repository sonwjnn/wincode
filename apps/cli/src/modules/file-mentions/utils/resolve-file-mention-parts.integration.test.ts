import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFileMentionParts } from "./resolve-file-mention-parts";

const workspaces: string[] = [];

const createWorkspace = async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "wincode-mentions-"));
	workspaces.push(workspace);
	return workspace;
};

afterEach(async () => {
	while (workspaces.length > 0) {
		const workspace = workspaces.pop();
		if (workspace) {
			await rm(workspace, { force: true, recursive: true });
		}
	}
});

describe("file mention resolver", () => {
	test("resolves file mentions to bounded data parts", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "apps/cli"), { recursive: true });
		await writeFile(
			path.join(workspace, "apps/cli/file.ts"),
			"export const x = 1;"
		);

		const parts = await resolveFileMentionParts("fix @apps/cli/file.ts", {
			root: workspace,
		});

		expect(parts).toEqual([
			{
				data: {
					byteLength: 19,
					content: "export const x = 1;",
					kind: "file",
					path: "apps/cli/file.ts",
					truncated: false,
				},
				type: "data-fileMention",
			},
		]);
	});

	test("resolves directory mentions as bounded trees", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "apps/cli/src"), { recursive: true });
		await writeFile(path.join(workspace, "apps/cli/package.json"), "{}");
		await writeFile(path.join(workspace, "apps/cli/src/index.ts"), "");

		const [part] = await resolveFileMentionParts("inspect @apps/cli/", {
			maxDirectoryDepth: 1,
			root: workspace,
		});

		expect(part?.data).toMatchObject({
			kind: "directory",
			path: "apps/cli",
		});
		expect(part?.data.content).toContain("apps/cli/");
		expect(part?.data.content).toContain("src/");
		expect(part?.data.content).toContain("package.json");
	});

	test("rejects mentions that escape the workspace", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		await writeFile(path.join(outside, "secret.txt"), "secret");
		await symlink(
			path.join(outside, "secret.txt"),
			path.join(workspace, "link")
		);

		const parts = await resolveFileMentionParts("read @link", {
			root: workspace,
		});

		expect(parts[0]?.data.error).toBe("Path escapes workspace: link");
	});

	test("ignores quoted file mentions", async () => {
		const workspace = await createWorkspace();
		await writeFile(path.join(workspace, "secret.txt"), "secret");

		await expect(
			resolveFileMentionParts('ignore "@secret.txt"', { root: workspace })
		).resolves.toEqual([]);
	});

	test("resolves a unique basename fallback to its canonical path", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "apps/cli/src"), { recursive: true });
		await writeFile(
			path.join(workspace, "apps/cli/src/bot-message.tsx"),
			"export const message = true;"
		);

		const [part] = await resolveFileMentionParts("inspect @bot-message", {
			root: workspace,
		});

		expect(part?.data).toMatchObject({
			content: "export const message = true;",
			kind: "file",
			path: "apps/cli/src/bot-message.tsx",
		});
	});

	test("resolves an extensionless stem fallback", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(path.join(workspace, "src/config.json"), '{"ok":true}');

		const [part] = await resolveFileMentionParts("inspect @config", {
			root: workspace,
		});

		expect(part?.data.path).toBe("src/config.json");
		expect(part?.data.error).toBeUndefined();
	});

	test("keeps literal paths ahead of basename fallback", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "nested"), { recursive: true });
		await writeFile(path.join(workspace, "target"), "literal");
		await writeFile(path.join(workspace, "nested/target.ts"), "fallback");

		const [part] = await resolveFileMentionParts("inspect @target", {
			root: workspace,
		});

		expect(part?.data).toMatchObject({
			content: "literal",
			path: "target",
		});
	});

	test("reports bounded ambiguity instead of choosing a basename match", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "apps/cli"), { recursive: true });
		await mkdir(path.join(workspace, "packages/cli"), { recursive: true });
		await writeFile(path.join(workspace, "apps/cli/index.ts"), "apps");
		await writeFile(path.join(workspace, "packages/cli/index.ts"), "packages");

		const [part] = await resolveFileMentionParts("inspect @index", {
			root: workspace,
		});

		expect(part?.data.error).toContain("Ambiguous file mention");
		expect(part?.data.error).toContain("apps/cli/index.ts");
		expect(part?.data.error).toContain("packages/cli/index.ts");
		expect(part?.data.content).toBe("");
	});

	test("does not use fuzzy suggestions for resolver fallback", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(path.join(workspace, "src/bot-message.tsx"), "content");

		const [part] = await resolveFileMentionParts("inspect @botmsg", {
			root: workspace,
		});

		expect(part?.data.error).toContain("ENOENT");
	});

	test("deduplicates literal and fallback references by canonical path", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "src"), { recursive: true });
		await writeFile(path.join(workspace, "src/target.ts"), "content");

		const parts = await resolveFileMentionParts(
			"inspect @target and @src/target.ts",
			{ root: workspace }
		);

		expect(parts).toHaveLength(1);
		expect(parts[0]?.data.path).toBe("src/target.ts");
	});

	test("does not resolve files from ignored directories by basename", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "node_modules"), { recursive: true });
		await writeFile(path.join(workspace, "node_modules/ignored.ts"), "ignored");

		const [part] = await resolveFileMentionParts("inspect @ignored", {
			root: workspace,
		});

		expect(part?.data.error).toContain("ENOENT");
	});

	test("does not use basename fallback for an escaping symlink", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		await mkdir(path.join(workspace, "nested"), { recursive: true });
		await writeFile(path.join(outside, "secret.txt"), "secret");
		await writeFile(path.join(workspace, "nested/link.ts"), "inside");
		await symlink(
			path.join(outside, "secret.txt"),
			path.join(workspace, "link")
		);

		const [part] = await resolveFileMentionParts("read @link", {
			root: workspace,
		});

		expect(part?.data.error).toBe("Path escapes workspace: link");
	});
	test("allows exact ignored paths but excludes them from basename fallback", async () => {
		const workspace = await createWorkspace();
		await mkdir(path.join(workspace, "private"));
		await writeFile(path.join(workspace, ".gitignore"), "private/\n");
		await writeFile(path.join(workspace, "private/secret.ts"), "secret");

		const [literalPart] = await resolveFileMentionParts(
			"inspect @private/secret.ts",
			{ root: workspace }
		);
		expect(literalPart?.data).toMatchObject({
			content: "secret",
			path: "private/secret.ts",
		});

		const [fallbackPart] = await resolveFileMentionParts("inspect @secret", {
			root: workspace,
		});
		expect(fallbackPart?.data.error).toContain("ENOENT");
	});
});
