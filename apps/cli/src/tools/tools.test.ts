import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveWithinWorkspace } from "./resolve-within-workspace";
import { runTool } from "./run-tool";

const workspace = process.cwd();
let sandboxPath = "";
let sandboxRelPath = "";

beforeEach(() => {
	sandboxRelPath = `.tool-test-${crypto.randomUUID()}`;
	sandboxPath = path.join(workspace, sandboxRelPath);
	mkdirSync(sandboxPath);
});

afterEach(() => {
	rmSync(sandboxPath, { force: true, recursive: true });
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
});

describe("runTool", () => {
	test("writes parent directories, reads files, and edits content", async () => {
		const filePath = `${sandboxRelPath}/nested/file.txt`;

		await expect(
			runTool("write", { content: "hello world", path: filePath })
		).resolves.toEqual({ bytesWritten: 11, path: filePath });
		expect(existsSync(path.join(workspace, filePath))).toBe(true);

		await expect(runTool("read", { path: filePath })).resolves.toEqual({
			content: "hello world",
			path: filePath,
		});

		await expect(
			runTool("edit", {
				find: "world",
				path: filePath,
				replace: "agent",
			})
		).resolves.toEqual({ path: filePath, replacements: 1 });
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			"hello agent"
		);
	});

	test("lists files and greps text within the workspace", async () => {
		writeFileSync(path.join(sandboxPath, "alpha.txt"), "alpha\nbeta\n");
		writeFileSync(path.join(sandboxPath, "gamma.txt"), "gamma\n");

		await expect(
			runTool("list", { depth: 1, path: sandboxRelPath })
		).resolves.toEqual({
			entries: [
				{ path: `${sandboxRelPath}/alpha.txt`, type: "file" },
				{ path: `${sandboxRelPath}/gamma.txt`, type: "file" },
			],
		});

		await expect(
			runTool("grep", { pattern: "beta", path: sandboxRelPath })
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

	test("runs bash in the workspace", async () => {
		await expect(runTool("bash", { command: "pwd" })).resolves.toMatchObject({
			exitCode: 0,
			stderr: "",
			stdout: `${workspace}\n`,
		});
	});
});
