import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceSandbox, resolveWithinWorkspace } from "../workspace";
import { runEditTool } from "./edit/runner";
import { runGrepTool } from "./grep/runner";
import { runListTool } from "./list/runner";
import { runReadTool } from "./read/runner";
import { runWriteTool } from "./write/runner";

const workspace = process.cwd();
let sandboxPath = "";
let sandboxRelPath = "";
let outsidePath = "";

beforeEach(() => {
	sandboxRelPath = `.tool-test-${crypto.randomUUID()}`;
	sandboxPath = path.join(workspace, sandboxRelPath);
	outsidePath = mkdtempSync(path.join(tmpdir(), "wincode-tool-test-"));
	mkdirSync(sandboxPath);
});

afterEach(() => {
	rmSync(sandboxPath, { force: true, recursive: true });
	rmSync(outsidePath, { force: true, recursive: true });
});

describe("resolveWithinWorkspace", () => {
	test("resolves relative paths inside the workspace", () => {
		expect(resolveWithinWorkspace(`${sandboxRelPath}/file.txt`)).toBe(
			path.join(workspace, sandboxRelPath, "file.txt")
		);
	});

	test("rejects paths that escape the workspace", () => {
		expect(() => resolveWithinWorkspace("../../etc/passwd")).toThrow(
			"Path escapes workspace: ../../etc/passwd"
		);
	});

	test("resolves existing paths through real workspace targets", async () => {
		const sandbox = await createWorkspaceSandbox();
		const filePath = `${sandboxRelPath}/file.txt`;
		writeFileSync(path.join(workspace, filePath), "inside");

		await expect(sandbox.resolveExistingPath(filePath)).resolves.toBe(
			path.join(workspace, filePath)
		);
	});

	test("rejects absolute paths outside the workspace", async () => {
		const sandbox = await createWorkspaceSandbox();
		const outsideFile = path.join(outsidePath, "outside.txt");
		writeFileSync(outsideFile, "outside");

		await expect(sandbox.resolveExistingPath(outsideFile)).rejects.toThrow(
			`Path escapes workspace: ${outsideFile}`
		);
	});

	test("rejects symlink escapes for existing paths", async () => {
		const sandbox = await createWorkspaceSandbox();
		const outsideFile = path.join(outsidePath, "outside.txt");
		const linkPath = `${sandboxRelPath}/outside-link.txt`;

		writeFileSync(outsideFile, "outside");
		symlinkSync(outsideFile, path.join(workspace, linkPath));

		await expect(sandbox.resolveExistingPath(linkPath)).rejects.toThrow(
			`Path escapes workspace: ${linkPath}`
		);
	});

	test("resolves new nested paths under the workspace", async () => {
		const sandbox = await createWorkspaceSandbox();
		const filePath = `${sandboxRelPath}/nested/new.txt`;

		await expect(sandbox.resolveNewPath(filePath)).resolves.toBe(
			path.join(workspace, filePath)
		);
	});

	test("rejects new paths through symlink parents", async () => {
		const sandbox = await createWorkspaceSandbox();
		const linkPath = `${sandboxRelPath}/outside-dir`;
		const filePath = `${linkPath}/new.txt`;

		symlinkSync(outsidePath, path.join(workspace, linkPath));

		await expect(sandbox.resolveNewPath(filePath)).rejects.toThrow(
			`Path escapes workspace: ${filePath}`
		);
	});

	test("formats workspace-relative paths with POSIX separators", async () => {
		const sandbox = await createWorkspaceSandbox();
		const absolutePath = path.join(
			workspace,
			sandboxRelPath,
			"nested",
			"file.txt"
		);

		expect(sandbox.relativePath(absolutePath)).toBe(
			`${sandboxRelPath}/nested/file.txt`
		);
	});
});

describe("tool runners", () => {
	test("writes parent directories, reads files, and edits content", async () => {
		const filePath = `${sandboxRelPath}/nested/file.txt`;

		await expect(
			runWriteTool({ content: "hello world", path: filePath })
		).resolves.toEqual({ bytesWritten: 11, path: filePath });
		expect(existsSync(path.join(workspace, filePath))).toBe(true);

		await expect(runReadTool({ path: filePath })).resolves.toEqual({
			content: "hello world",
			path: filePath,
		});

		const result = await runEditTool({
			find: "world",
			path: filePath,
			replace: "agent",
		});

		expect(result.path).toBe(filePath);
		expect(result.replacements).toBe(1);
		expect(result.editDiff).toMatchObject({
			additions: 1,
			deletions: 1,
			omittedHunks: 0,
			truncated: false,
		});
		expect(result.editDiff?.patch).toContain("-hello world");
		expect(result.editDiff?.patch).toContain("+hello agent");
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			"hello agent"
		);
	});
	test("reads an approved absolute path outside the workspace", async () => {
		const filename = `.wincode-read-test-${crypto.randomUUID()}`;
		const absolutePath = path.join(homedir(), filename);
		writeFileSync(absolutePath, "home content");
		try {
			await expect(
				runReadTool({ path: absolutePath }, { allowExternalPath: true })
			).resolves.toEqual({
				content: "home content",
				path: absolutePath,
			});
		} finally {
			rmSync(absolutePath, { force: true });
		}
	});
	test("overwrites an existing file with complete replacement content", async () => {
		const filePath = `${sandboxRelPath}/existing.txt`;
		writeFileSync(path.join(workspace, filePath), "original");

		await expect(
			runWriteTool({ content: "replacement", path: filePath })
		).resolves.toEqual({ bytesWritten: 11, path: filePath });
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			"replacement"
		);
	});
	test("rejects overwriting a symlink target outside the workspace", async () => {
		const outsideFile = path.join(outsidePath, "outside.txt");
		const linkPath = `${sandboxRelPath}/outside-write-link.txt`;
		writeFileSync(outsideFile, "outside");
		symlinkSync(outsideFile, path.join(workspace, linkPath));

		await expect(
			runWriteTool({ content: "replacement", path: linkPath })
		).rejects.toThrow(`Path escapes workspace: ${linkPath}`);
		expect(readFileSync(outsideFile, "utf8")).toBe("outside");
	});
	test("reports every replacement in a multi-replacement edit diff", async () => {
		const filePath = `${sandboxRelPath}/unicode.txt`;
		const before = "café\ncafé\n";
		writeFileSync(path.join(workspace, filePath), before);

		const result = await runEditTool({
			find: "café",
			path: filePath,
			replace: "茶",
			replaceAll: true,
		});

		expect(result.replacements).toBe(2);
		expect(result.editDiff).toMatchObject({
			additions: 2,
			deletions: 2,
			omittedHunks: 0,
			truncated: false,
		});
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			"茶\n茶\n"
		);
	});
	test("rejects no-op edits instead of reporting false success", async () => {
		const filePath = `${sandboxRelPath}/content.txt`;
		const content = "unchanged";
		writeFileSync(path.join(workspace, filePath), content);

		await expect(
			runEditTool({
				find: content,
				path: filePath,
				replace: content,
			})
		).rejects.toThrow(`Edit produced no content changes: ${filePath}`);
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(content);
	});
	test("writes long replacement content from a small exact match", async () => {
		const filePath = `${sandboxRelPath}/long-content.txt`;
		const replacement = Array.from(
			{ length: 1000 },
			(_, index) => `new line ${index + 1}`
		).join("\n");
		writeFileSync(path.join(workspace, filePath), "replace me");

		const result = await runEditTool({
			find: "replace me",
			path: filePath,
			replace: replacement,
		});

		expect(result.replacements).toBe(1);
		expect(result.editDiff?.additions).toBe(1000);
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			replacement
		);
	});
	test("replaces a long existing file without resending its original content", async () => {
		const filePath = `${sandboxRelPath}/long-existing.txt`;
		const replacement = Array.from(
			{ length: 1000 },
			(_, index) => `replacement line ${index + 1}`
		).join("\n");
		writeFileSync(path.join(workspace, filePath), "old content");

		const result = await runEditTool({
			content: replacement,
			path: filePath,
		});

		expect(result.replacements).toBe(1);
		expect(result.editDiff?.additions).toBe(1000);
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			replacement
		);
	});

	test("lists files and greps text within the workspace", async () => {
		writeFileSync(path.join(sandboxPath, "alpha.txt"), "alpha\nbeta\n");
		writeFileSync(path.join(sandboxPath, "gamma.txt"), "gamma\n");

		await expect(
			runListTool({ depth: 1, path: sandboxRelPath })
		).resolves.toEqual({
			entries: [
				{ path: `${sandboxRelPath}/alpha.txt`, type: "file" },
				{ path: `${sandboxRelPath}/gamma.txt`, type: "file" },
			],
		});

		await expect(
			runGrepTool({ pattern: "beta", path: sandboxRelPath })
		).resolves.toEqual({
			matches: [
				{
					line: "beta",
					lineNumber: 2,
					path: `${sandboxRelPath}/alpha.txt`,
				},
			],
		});
	});

	test("lists entries in deterministic order while skipping ignored directories and symlinks", async () => {
		mkdirSync(path.join(sandboxPath, ".git"));
		mkdirSync(path.join(sandboxPath, "node_modules"));
		mkdirSync(path.join(sandboxPath, "zeta"));
		writeFileSync(path.join(sandboxPath, ".git", "ignored.txt"), "ignored");
		writeFileSync(
			path.join(sandboxPath, "node_modules", "ignored.txt"),
			"ignored"
		);
		writeFileSync(path.join(sandboxPath, "alpha.txt"), "alpha");
		writeFileSync(path.join(sandboxPath, "zeta", "nested.txt"), "nested");
		symlinkSync(
			path.join(sandboxPath, "alpha.txt"),
			path.join(sandboxPath, "alpha-link.txt")
		);
		symlinkSync(outsidePath, path.join(sandboxPath, "outside-dir-link"));
		expect(readlinkSync(path.join(sandboxPath, "outside-dir-link"))).toBe(
			outsidePath
		);

		await expect(
			runListTool({ depth: 2, path: sandboxRelPath })
		).resolves.toEqual({
			entries: [
				{ path: `${sandboxRelPath}/alpha.txt`, type: "file" },
				{ path: `${sandboxRelPath}/zeta`, type: "directory" },
				{ path: `${sandboxRelPath}/zeta/nested.txt`, type: "file" },
			],
		});
	});

	test("grep skips ignored directories", async () => {
		mkdirSync(path.join(sandboxPath, ".git"));
		mkdirSync(path.join(sandboxPath, "node_modules"));
		writeFileSync(path.join(sandboxPath, "keep.txt"), "needle\n");
		writeFileSync(path.join(sandboxPath, ".git", "ignored.txt"), "needle\n");
		writeFileSync(
			path.join(sandboxPath, "node_modules", "ignored.txt"),
			"needle\n"
		);

		await expect(
			runGrepTool({ pattern: "needle", path: sandboxRelPath })
		).resolves.toEqual({
			matches: [
				{
					line: "needle",
					lineNumber: 1,
					path: `${sandboxRelPath}/keep.txt`,
				},
			],
		});
	});

	test("grep uses an internal max depth of five", async () => {
		let currentPath = sandboxPath;

		for (const directory of ["a", "b", "c", "d", "e", "f"]) {
			currentPath = path.join(currentPath, directory);
			mkdirSync(currentPath);
		}

		writeFileSync(
			path.join(sandboxPath, "a", "b", "c", "d", "hit.txt"),
			"needle\n"
		);
		writeFileSync(path.join(currentPath, "miss.txt"), "needle\n");

		await expect(
			runGrepTool({ pattern: "needle", path: sandboxRelPath })
		).resolves.toEqual({
			matches: [
				{
					line: "needle",
					lineNumber: 1,
					path: `${sandboxRelPath}/a/b/c/d/hit.txt`,
				},
			],
		});
	});

	test("grep caps matches at the internal maximum", async () => {
		for (let index = 0; index < 1001; index += 1) {
			writeFileSync(
				path.join(sandboxPath, `${String(index).padStart(4, "0")}.txt`),
				"needle\n"
			);
		}

		const result = await runGrepTool({
			pattern: "needle",
			path: sandboxRelPath,
		});

		expect(result.matches.length).toBeLessThan(1000);
		expect(result.truncated).toBe(true);
	});

	test("grep skips files above the internal byte limit", async () => {
		writeFileSync(
			path.join(sandboxPath, "big.txt"),
			`${"x".repeat(1_000_001)}needle`
		);
		writeFileSync(path.join(sandboxPath, "small.txt"), "needle\n");

		await expect(
			runGrepTool({ pattern: "needle", path: sandboxRelPath })
		).resolves.toEqual({
			matches: [
				{
					line: "needle",
					lineNumber: 1,
					path: `${sandboxRelPath}/small.txt`,
				},
			],
		});
	});

	test("grep reports invalid patterns with a stable error", async () => {
		await expect(
			runGrepTool({ pattern: "[", path: sandboxRelPath })
		).rejects.toThrow("Invalid grep pattern.");
	});

	test("rejects reads through symlinks that escape the workspace", async () => {
		const outsideFile = path.join(outsidePath, "outside.txt");
		const linkPath = `${sandboxRelPath}/outside-link.txt`;

		writeFileSync(outsideFile, "outside");
		symlinkSync(outsideFile, path.join(workspace, linkPath));

		await expect(runReadTool({ path: linkPath })).rejects.toThrow(
			`Path escapes workspace: ${linkPath}`
		);
	});

	test("rejects writes through symlink parents that escape the workspace", async () => {
		const linkPath = `${sandboxRelPath}/outside-dir`;
		const filePath = `${linkPath}/new.txt`;

		symlinkSync(outsidePath, path.join(workspace, linkPath));

		await expect(
			runWriteTool({ content: "outside", path: filePath })
		).rejects.toThrow(`Path escapes workspace: ${filePath}`);
		expect(existsSync(path.join(outsidePath, "new.txt"))).toBe(false);
	});
});
