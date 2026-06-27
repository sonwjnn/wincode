import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFileMentionParts } from "./file-mentions";

const createWorkspace = () => mkdtemp(path.join(tmpdir(), "wincode-mentions-"));

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
});
