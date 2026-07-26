import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceSandbox } from "@wincode/ai/workspace";

let workspace = "";
let outside = "";

beforeEach(() => {
	workspace = mkdtempSync(path.join(tmpdir(), "wincode-workspace-"));
	outside = mkdtempSync(path.join(tmpdir(), "wincode-outside-"));
});

afterEach(() => {
	rmSync(workspace, { force: true, recursive: true });
	rmSync(outside, { force: true, recursive: true });
});

describe("workspace policy", () => {
	test("rejects existing and new paths that escape the workspace", async () => {
		const policy = createWorkspaceSandbox(workspace);
		const outsideFile = path.join(outside, "secret.txt");
		const linkPath = "outside-link";
		const linkChildPath = `${linkPath}/new.txt`;

		writeFileSync(outsideFile, "secret");
		symlinkSync(outsideFile, path.join(workspace, "file-link"));
		symlinkSync(outside, path.join(workspace, linkPath));

		await expect(policy.resolveExistingPath("../escape.txt")).rejects.toThrow(
			"Path escapes workspace: ../escape.txt"
		);
		await expect(policy.resolveExistingPath("file-link")).rejects.toThrow(
			"Path escapes workspace: file-link"
		);
		await expect(policy.resolveNewPath(linkChildPath)).rejects.toThrow(
			`Path escapes workspace: ${linkChildPath}`
		);
	});

	test("traverses sorted entries while skipping ignored dirs and symlinks", async () => {
		const policy = createWorkspaceSandbox(workspace);

		mkdirSync(path.join(workspace, ".git"));
		mkdirSync(path.join(workspace, ".tanstack"));
		mkdirSync(path.join(workspace, "src"));
		writeFileSync(path.join(workspace, ".git", "ignored.txt"), "ignored");
		writeFileSync(path.join(workspace, ".tanstack", "ignored.txt"), "ignored");
		writeFileSync(path.join(workspace, "alpha.txt"), "alpha");
		writeFileSync(path.join(workspace, "src", "index.ts"), "index");
		symlinkSync(
			path.join(workspace, "alpha.txt"),
			path.join(workspace, "alpha-link")
		);

		await expect(
			policy.traverse({
				includeDirectories: true,
				includeFiles: true,
				maxDepth: 2,
			})
		).resolves.toMatchObject({
			entries: [
				{ relativePath: "alpha.txt", type: "file" },
				{ relativePath: "src", type: "directory" },
				{ relativePath: "src/index.ts", type: "file" },
			],
			truncated: false,
		});
	});

	test("reports traversal truncation for depth and entry caps", async () => {
		const policy = createWorkspaceSandbox(workspace);

		mkdirSync(path.join(workspace, "a", "b"), { recursive: true });
		writeFileSync(path.join(workspace, "a", "b", "deep.txt"), "deep");
		writeFileSync(path.join(workspace, "root-a.txt"), "a");
		writeFileSync(path.join(workspace, "root-b.txt"), "b");

		await expect(
			policy.traverse({
				includeDirectories: true,
				includeFiles: true,
				maxDepth: 1,
			})
		).resolves.toMatchObject({ truncated: true });

		await expect(
			policy.traverse({
				includeDirectories: true,
				includeFiles: true,
				maxDepth: 3,
				maxEntries: 2,
			})
		).resolves.toMatchObject({
			entries: [{ relativePath: "a" }, { relativePath: "a/b" }],
			truncated: true,
		});
	});
});
