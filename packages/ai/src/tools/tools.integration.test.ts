import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceSandbox, resolveWithinWorkspace } from "../workspace";
import { runEditTool } from "./edit/runner";
import { createGlobRunner, runGlobTool } from "./glob/runner";
import { RipgrepUnavailableError } from "./grep/ripgrep";
import { createGrepRunner, runGrepTool } from "./grep/runner";
import { runReadTool } from "./read/runner";
import { getToolResourceLimits } from "./resource-limits";
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
			content: "1:hello world",
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
	test("reads a directory as a compact text tree", async () => {
		mkdirSync(path.join(sandboxPath, "zeta"));
		writeFileSync(path.join(sandboxPath, "zeta", "nested.ts"), "nested");
		writeFileSync(path.join(sandboxPath, "alpha.txt"), "alpha");

		await expect(runReadTool({ path: sandboxRelPath })).resolves.toEqual({
			content: ".\n  - zeta/\n    - nested.ts\n  - alpha.txt",
			path: sandboxRelPath,
		});
	});
	test("limits directory trees to two levels and orders directories first", async () => {
		mkdirSync(path.join(sandboxPath, "zeta", "deep"), { recursive: true });
		mkdirSync(path.join(sandboxPath, "alpha-dir"));
		writeFileSync(path.join(sandboxPath, "zeta", "nested.ts"), "nested");
		writeFileSync(path.join(sandboxPath, "zeta", "deep", "hidden.ts"), "deep");
		writeFileSync(path.join(sandboxPath, "alpha-dir", "child.ts"), "child");
		writeFileSync(path.join(sandboxPath, "alpha.txt"), "alpha");

		await expect(runReadTool({ path: sandboxRelPath })).resolves.toEqual({
			content:
				".\n  - alpha-dir/\n    - child.ts\n  - zeta/\n    - deep/\n    - nested.ts\n  - alpha.txt",
			path: sandboxRelPath,
		});
	});

	test("limits each directory to twelve children and reports omissions", async () => {
		for (let index = 1; index <= 14; index += 1) {
			writeFileSync(
				path.join(sandboxPath, `file-${String(index).padStart(2, "0")}.txt`),
				"file"
			);
		}

		const result = await runReadTool({ path: sandboxRelPath });

		expect(result.content).toBe(
			[
				".",
				...Array.from(
					{ length: 12 },
					(_, index) => `  - file-${String(index + 1).padStart(2, "0")}.txt`
				),
				"  - … 2 more",
			].join("\n")
		);
		expect(result.truncated).toBe(true);
	});
	test("hides discovery-only entries while allowing explicit targets", async () => {
		writeFileSync(
			path.join(sandboxPath, ".gitignore"),
			"ignored.txt\nignored-dir/\n"
		);
		mkdirSync(path.join(sandboxPath, "ignored-dir"));
		mkdirSync(path.join(sandboxPath, ".hidden-dir"));
		writeFileSync(path.join(sandboxPath, "ignored.txt"), "ignored");
		writeFileSync(path.join(sandboxPath, "ignored-dir", "child.txt"), "child");
		writeFileSync(
			path.join(sandboxPath, ".hidden-dir", "child.txt"),
			"hidden child"
		);
		writeFileSync(path.join(sandboxPath, ".hidden-file"), "hidden");
		writeFileSync(path.join(sandboxPath, "visible.txt"), "visible");

		await expect(runReadTool({ path: sandboxRelPath })).resolves.toEqual({
			content: ".\n  - visible.txt",
			path: sandboxRelPath,
		});
		await expect(
			runReadTool({ path: `${sandboxRelPath}/ignored.txt` })
		).resolves.toEqual({
			content: "1:ignored",
			path: `${sandboxRelPath}/ignored.txt`,
		});
		await expect(
			runReadTool({ path: `${sandboxRelPath}/ignored-dir` })
		).resolves.toEqual({
			content: "(empty directory)",
			path: `${sandboxRelPath}/ignored-dir`,
		});
		await expect(
			runReadTool({ path: `${sandboxRelPath}/.hidden-file` })
		).resolves.toEqual({
			content: "1:hidden",
			path: `${sandboxRelPath}/.hidden-file`,
		});
		await expect(
			runReadTool({ path: `${sandboxRelPath}/.hidden-dir` })
		).resolves.toEqual({
			content: ".\n  - child.txt",
			path: `${sandboxRelPath}/.hidden-dir`,
		});
	});

	test("prunes .git while displaying symlinks without traversing them", async () => {
		mkdirSync(path.join(sandboxPath, ".git"));
		mkdirSync(path.join(sandboxPath, ".git", "objects"));
		mkdirSync(path.join(sandboxPath, "real-dir"));
		writeFileSync(
			path.join(sandboxPath, ".git", "objects", "secret"),
			"secret"
		);
		writeFileSync(path.join(sandboxPath, "real-dir", "child.txt"), "child");
		symlinkSync("real-dir\nwith-control", path.join(sandboxPath, "dir-link"));

		const result = await runReadTool({ path: sandboxRelPath });

		expect(result.content).toBe(
			".\n  - real-dir/\n    - child.txt\n  - dir-link -> real-dir with-control"
		);
		expect(result.content).not.toContain("secret");
		expect(result.content).not.toContain("dir-link/child.txt");
		await expect(
			runReadTool({ path: `${sandboxRelPath}/.git/objects` })
		).resolves.toEqual({
			content: "(empty directory)",
			path: `${sandboxRelPath}/.git/objects`,
		});
	});
	test("does not traverse an explicitly read symlinked directory", async () => {
		mkdirSync(path.join(sandboxPath, "real-dir"));
		writeFileSync(path.join(sandboxPath, "real-dir", "child.txt"), "child");
		symlinkSync("real-dir", path.join(sandboxPath, "dir-link"));

		await expect(
			runReadTool({ path: `${sandboxRelPath}/dir-link` })
		).resolves.toEqual({
			content: "real-dir",
			path: `${sandboxRelPath}/dir-link`,
		});
	});
	test("continues directory entries without counting omission notices", async () => {
		for (let index = 1; index <= 14; index += 1) {
			writeFileSync(
				path.join(sandboxPath, `file-${String(index).padStart(2, "0")}.txt`),
				"file"
			);
		}

		await expect(
			runReadTool({ path: `${sandboxRelPath}:13` })
		).resolves.toEqual({
			content: "  - file-12.txt\n  - … 2 more",
			path: sandboxRelPath,
			truncated: true,
		});
		await expect(runReadTool({ path: `${sandboxRelPath}:14` })).rejects.toThrow(
			"Line range starts at 14, beyond end of directory listing (13 entries)"
		);
	});
	test("prefers an existing literal directory over a line selector", async () => {
		const directoryPath = `${sandboxRelPath}/literal:1-2`;
		mkdirSync(path.join(workspace, directoryPath));
		writeFileSync(path.join(workspace, directoryPath, "child.txt"), "child");

		await expect(runReadTool({ path: directoryPath })).resolves.toEqual({
			content: ".\n  - child.txt",
			path: directoryPath,
		});
	});
	test("renders an empty directory explicitly", async () => {
		const emptyDirectory = `${sandboxRelPath}/empty`;
		mkdirSync(path.join(workspace, emptyDirectory));

		await expect(runReadTool({ path: emptyDirectory })).resolves.toEqual({
			content: "(empty directory)",
			path: emptyDirectory,
		});
	});
	test("reads approved external directories through the same tree renderer", async () => {
		mkdirSync(path.join(outsidePath, "nested"));
		writeFileSync(path.join(outsidePath, "nested", "child.txt"), "child");

		await expect(
			runReadTool({ path: outsidePath }, { allowExternalPath: true })
		).resolves.toEqual({
			content: ".\n  - nested/\n    - child.txt",
			path: outsidePath,
		});
	});
	test("prunes an explicitly approved external .git root", async () => {
		const externalGitPath = path.join(outsidePath, ".git");
		mkdirSync(externalGitPath);
		writeFileSync(path.join(externalGitPath, "secret"), "secret");

		await expect(
			runReadTool({ path: externalGitPath }, { allowExternalPath: true })
		).resolves.toEqual({
			content: "(empty directory)",
			path: externalGitPath,
		});
		const nestedGitObjects = path.join(
			outsidePath,
			"repository",
			".git",
			"objects"
		);
		mkdirSync(nestedGitObjects, { recursive: true });
		writeFileSync(path.join(nestedGitObjects, "secret"), "secret");
		await expect(
			runReadTool({ path: nestedGitObjects }, { allowExternalPath: true })
		).resolves.toEqual({
			content: "(empty directory)",
			path: nestedGitObjects,
		});
	});
	test("caps directory output with its dedicated resource limit", async () => {
		for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
			writeFileSync(
				path.join(sandboxPath, `${name}-${"x".repeat(100)}.txt`),
				"x"
			);
		}

		const standard = getToolResourceLimits("standard");
		const result = await runReadTool(
			{ path: sandboxRelPath },
			{
				resourceLimits: {
					...standard,
					read: {
						...standard.read,
						maxDirectoryOutputBytes: 256,
					},
				},
			}
		);

		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(256);
		expect(result.content).toContain("[Output capped at 256 bytes.");
	});
	test("reads a line range with Oh My Pi context", async () => {
		const filePath = `${sandboxRelPath}/range.txt`;
		writeFileSync(
			path.join(workspace, filePath),
			"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine"
		);

		await expect(runReadTool({ path: `${filePath}:4-5` })).resolves.toEqual({
			content: "3:three\n4:four\n5:five\n6:six\n7:seven\n8:eight",
			path: filePath,
		});
	});
	test("reads normalized Oh My Pi multi-range aliases", async () => {
		const filePath = `${sandboxRelPath}/multi-range.txt`;
		const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
		writeFileSync(path.join(workspace, filePath), lines.join("\n"));

		await expect(
			runReadTool({ path: `${filePath}:12+2,L4..L5` })
		).resolves.toEqual({
			content: [
				"3:line 3",
				"4:line 4",
				"5:line 5",
				"6:line 6",
				"7:line 7",
				"8:line 8",
				"…",
				"11:line 11",
				"12:line 12",
				"13:line 13",
				"14:line 14",
				"15:line 15",
				"16:line 16",
			].join("\n"),
			path: filePath,
		});
	});
	test("treats bare and trailing-dash selectors as open-ended", async () => {
		const filePath = `${sandboxRelPath}/open-range.txt`;
		writeFileSync(
			path.join(workspace, filePath),
			"one\ntwo\nthree\nfour\nfive\nsix"
		);
		const expected = {
			content: "3:three\n4:four\n5:five\n6:six",
			path: filePath,
		};

		await expect(runReadTool({ path: `${filePath}:4` })).resolves.toEqual(
			expected
		);
		await expect(runReadTool({ path: `${filePath}:L4..` })).resolves.toEqual(
			expected
		);
		await expect(runReadTool({ path: `${filePath}:4-` })).resolves.toEqual(
			expected
		);
	});
	test("rejects malformed selector bounds", async () => {
		const filePath = `${sandboxRelPath}/malformed-range.txt`;
		writeFileSync(path.join(workspace, filePath), "one\ntwo\nthree\nfour");

		await expect(runReadTool({ path: `${filePath}:4-2` })).rejects.toThrow(
			"Invalid line range 4-2: end must not precede start"
		);
		await expect(runReadTool({ path: `${filePath}:3--4` })).rejects.toThrow(
			"Invalid line range selector: 3--4"
		);
	});
	test("prefers an existing literal path over a line range selector", async () => {
		const filePath = `${sandboxRelPath}/literal:1-2`;
		writeFileSync(path.join(workspace, filePath), "literal\npath");

		await expect(runReadTool({ path: filePath })).resolves.toEqual({
			content: "1:literal\n2:path",
			path: filePath,
		});
	});
	test("does not reinterpret a dangling literal path as a selector", async () => {
		const filePath = `${sandboxRelPath}/dangling:1-2`;
		symlinkSync("missing-target", path.join(workspace, filePath));

		await expect(runReadTool({ path: filePath })).rejects.toThrow(filePath);
	});
	test("rejects a multi-range when any range begins beyond EOF", async () => {
		const filePath = `${sandboxRelPath}/short.txt`;
		writeFileSync(path.join(workspace, filePath), "one\ntwo\nthree\nfour");

		await expect(
			runReadTool({ path: `${filePath}:2-3,99-100` })
		).rejects.toThrow("Line range starts at 99, beyond end of file (4 lines)");
	});
	test("truncates on a line boundary with a remaining multi-range selector", async () => {
		const filePath = `${sandboxRelPath}/bounded.txt`;
		const line = "x".repeat(100);
		writeFileSync(
			path.join(workspace, filePath),
			Array.from({ length: 160 }, () => line).join("\n")
		);

		const result = await runReadTool({
			path: `${filePath}:1-100,150-160`,
		});

		expect(result).toMatchObject({ path: filePath, truncated: true });
		expect(result.content).toContain(`56:${line}`);
		expect(result.content).not.toContain(`57:${line}`);
		expect(result.content).toEndWith(
			`[Output capped at 6000 bytes. Continue with path \`${filePath}:57-100,150-160\`.]`
		);
	});
	test("continues when the byte cap cuts trailing range context", async () => {
		const filePath = `${sandboxRelPath}/bounded-context.txt`;
		const line = "x".repeat(112);
		writeFileSync(
			path.join(workspace, filePath),
			Array.from({ length: 60 }, () => line).join("\n")
		);

		const result = await runReadTool({ path: `${filePath}:1-50` });

		expect(result).toMatchObject({ path: filePath, truncated: true });
		expect(result.content).toContain(`50:${line}`);
		expect(result.content).not.toContain(`51:${line}`);
		expect(result.content).toEndWith(
			`[Output capped at 6000 bytes. Continue with path \`${filePath}:51-53\`.]`
		);
	});
	test("uses the selected resource profile for large reads", async () => {
		const filePath = `${sandboxRelPath}/large-read.txt`;
		const content = "x".repeat(60 * 1024);
		writeFileSync(path.join(workspace, filePath), content);

		await expect(runReadTool({ path: filePath })).rejects.toThrow(
			"exceeds the 6000-byte read limit"
		);
		await expect(
			runReadTool(
				{ path: filePath },
				{ resourceLimits: getToolResourceLimits("extended") }
			)
		).resolves.toEqual({
			content: `1:${content}`,
			path: filePath,
		});
	});
	test("keeps file reads at six kilobytes while directories use fifty", async () => {
		const largeFilePath = `${sandboxRelPath}/large-file.txt`;
		writeFileSync(path.join(workspace, largeFilePath), "x".repeat(7000));
		await expect(runReadTool({ path: largeFilePath })).rejects.toThrow(
			"exceeds the 6000-byte read limit"
		);

		for (let directoryIndex = 1; directoryIndex <= 11; directoryIndex += 1) {
			const directoryName = `directory-${String(directoryIndex).padStart(2, "0")}`;
			mkdirSync(path.join(sandboxPath, directoryName));
			for (let fileIndex = 1; fileIndex <= 12; fileIndex += 1) {
				const filename = `entry-${String(fileIndex).padStart(2, "0")}-${"x".repeat(200)}.txt`;
				writeFileSync(path.join(sandboxPath, directoryName, filename), "x");
			}
		}

		const directoryResult = await runReadTool({ path: sandboxRelPath });
		const directoryBytes = Buffer.byteLength(directoryResult.content, "utf8");
		expect(directoryBytes).toBeGreaterThan(6000);
		expect(directoryBytes).toBeLessThanOrEqual(50 * 1024);
		expect(directoryResult.truncated).toBeUndefined();
	});
	test("reads an approved absolute path outside the workspace", async () => {
		const filename = `.wincode-read-test-${crypto.randomUUID()}`;
		const absolutePath = path.join(homedir(), filename);
		writeFileSync(absolutePath, "home content");
		try {
			await expect(
				runReadTool({ path: absolutePath }, { allowExternalPath: true })
			).resolves.toEqual({
				content: "1:home content",
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
	test("rejects stale hashline edits without writing", async () => {
		const filePath = `${sandboxRelPath}/stale.txt`;
		writeFileSync(path.join(workspace, filePath), "alpha\nbeta\n");
		await expect(
			runEditTool({
				content: "changed",
				lineHashes: "1:zz",
				path: filePath,
			})
		).rejects.toThrow("Hashline mismatch at line 1");
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			"alpha\nbeta\n"
		);
	});

	test("applies verified hashline edits", async () => {
		const filePath = `${sandboxRelPath}/hashline.txt`;
		writeFileSync(path.join(workspace, filePath), "alpha\nbeta\n");
		await expect(
			runEditTool({
				content: "ALPHA",
				lineHashes: "1:lb",
				path: filePath,
			})
		).resolves.toMatchObject({ path: filePath, replacements: 1 });
		expect(readFileSync(path.join(workspace, filePath), "utf8")).toBe(
			"ALPHA\nbeta\n"
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

	test("globs files and greps text within the workspace", async () => {
		writeFileSync(path.join(sandboxPath, "alpha.txt"), "alpha\nbeta\n");
		writeFileSync(path.join(sandboxPath, "gamma.txt"), "gamma\n");

		await expect(
			runGlobTool({ pattern: "*.txt", path: sandboxRelPath })
		).resolves.toEqual({
			paths: [`${sandboxRelPath}/gamma.txt`, `${sandboxRelPath}/alpha.txt`],
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
	test("scopes glob matches and treats no matches as success", async () => {
		const sourcePath = path.join(sandboxPath, "src");
		mkdirSync(sourcePath);
		writeFileSync(path.join(sourcePath, "keep.ts"), "keep");
		writeFileSync(path.join(sandboxPath, "other.ts"), "other");

		await expect(
			runGlobTool({ path: `${sandboxRelPath}/src`, pattern: "*.ts" })
		).resolves.toEqual({
			paths: [`${sandboxRelPath}/src/keep.ts`],
		});
		await expect(
			runGlobTool({ path: `${sandboxRelPath}/src`, pattern: "*.tsx" })
		).resolves.toEqual({ paths: [] });
	});
	test("controls hidden and ignored discovery without entering .git", async () => {
		for (const directory of [".git", ".hidden", "ignored", "node_modules"]) {
			mkdirSync(path.join(sandboxPath, directory));
		}
		writeFileSync(path.join(sandboxPath, ".gitignore"), "ignored/\n");
		writeFileSync(path.join(sandboxPath, "visible.txt"), "visible");
		writeFileSync(path.join(sandboxPath, ".git", "metadata.txt"), "metadata");
		writeFileSync(path.join(sandboxPath, ".hidden", "secret.txt"), "secret");
		writeFileSync(
			path.join(sandboxPath, "ignored", "generated.txt"),
			"generated"
		);
		writeFileSync(
			path.join(sandboxPath, "node_modules", "dependency.txt"),
			"dependency"
		);

		const input = { path: sandboxRelPath, pattern: "**/*.txt" };
		await expect(runGlobTool(input)).resolves.toEqual({
			paths: [`${sandboxRelPath}/visible.txt`],
		});
		const hiddenResult = await runGlobTool({ ...input, includeHidden: true });
		expect(hiddenResult.paths).toHaveLength(2);
		expect(hiddenResult.paths).toEqual(
			expect.arrayContaining([
				`${sandboxRelPath}/.hidden/secret.txt`,
				`${sandboxRelPath}/visible.txt`,
			])
		);
		const ignoredResult = await runGlobTool({
			...input,
			includeIgnored: true,
			includeHidden: true,
		});
		expect(ignoredResult.paths).toHaveLength(4);
		expect(ignoredResult.paths).toEqual(
			expect.arrayContaining([
				`${sandboxRelPath}/.hidden/secret.txt`,
				`${sandboxRelPath}/ignored/generated.txt`,
				`${sandboxRelPath}/node_modules/dependency.txt`,
				`${sandboxRelPath}/visible.txt`,
			])
		);
		await expect(
			runGlobTool({
				...input,
				includeIgnored: true,
				includeHidden: true,
				path: `${sandboxRelPath}/.git`,
			})
		).resolves.toEqual({ paths: [] });
	});
	test("orders glob files by mtime and then path", async () => {
		const files = ["old.txt", "tie-b.txt", "tie-a.txt", "new.txt"];
		for (const filename of files) {
			writeFileSync(path.join(sandboxPath, filename), filename);
		}
		utimesSync(path.join(sandboxPath, "old.txt"), 1000, 1000);
		utimesSync(path.join(sandboxPath, "tie-b.txt"), 2000, 2000);
		utimesSync(path.join(sandboxPath, "tie-a.txt"), 2000, 2000);
		utimesSync(path.join(sandboxPath, "new.txt"), 3000, 3000);

		await expect(
			runGlobTool({ path: sandboxRelPath, pattern: "*.txt" })
		).resolves.toEqual({
			paths: [
				`${sandboxRelPath}/new.txt`,
				`${sandboxRelPath}/tie-a.txt`,
				`${sandboxRelPath}/tie-b.txt`,
				`${sandboxRelPath}/old.txt`,
			],
		});
	});
	test("reports invalid glob patterns clearly", async () => {
		await expect(
			runGlobTool({ path: sandboxRelPath, pattern: "[" })
		).rejects.toThrow("Invalid glob pattern");
	});
	test("surfaces glob backend failures without a fallback", async () => {
		const runner = createGlobRunner({
			search: async () => {
				throw new Error("ripgrep backend failed");
			},
		});

		await expect(
			runner({ path: sandboxRelPath, pattern: "*.txt" })
		).rejects.toThrow("ripgrep backend failed");
	});
	test("omits disappeared files and directories from glob results", async () => {
		const keepPath = path.join(sandboxPath, "keep.txt");
		writeFileSync(keepPath, "keep");
		writeFileSync(path.join(sandboxPath, "gone.txt"), "gone");
		mkdirSync(path.join(sandboxPath, "directory"));
		const runner = createGlobRunner({
			search: async () => ({
				paths: [
					`${sandboxRelPath}/gone.txt`,
					`${sandboxRelPath}/directory`,
					`${sandboxRelPath}/keep.txt`,
				],
			}),
			statFile: async (candidatePath) => {
				if (candidatePath.endsWith("gone.txt")) {
					throw new Error("gone");
				}
				return statSync(candidatePath);
			},
		});

		await expect(
			runner({ path: sandboxRelPath, pattern: "*.txt" })
		).resolves.toEqual({
			paths: [`${sandboxRelPath}/keep.txt`],
		});
	});
	test("reports result-limit truncation and keeps newest files", async () => {
		for (const filename of ["old.txt", "middle.txt", "new.txt"]) {
			writeFileSync(path.join(sandboxPath, filename), filename);
		}
		utimesSync(path.join(sandboxPath, "old.txt"), 1000, 1000);
		utimesSync(path.join(sandboxPath, "middle.txt"), 2000, 2000);
		utimesSync(path.join(sandboxPath, "new.txt"), 3000, 3000);

		await expect(
			runGlobTool({ limit: 2, path: sandboxRelPath, pattern: "*.txt" })
		).resolves.toEqual({
			paths: [`${sandboxRelPath}/new.txt`, `${sandboxRelPath}/middle.txt`],
			truncated: true,
		});
	});

	test("reports candidate and serialized-byte truncation", async () => {
		const candidateRunner = createGlobRunner({
			search: async () => ({
				paths: [`${sandboxRelPath}/candidate.txt`],
				truncated: true,
			}),
		});
		writeFileSync(path.join(sandboxPath, "candidate.txt"), "candidate");
		await expect(
			candidateRunner({ path: sandboxRelPath, pattern: "*.txt" })
		).resolves.toEqual({
			paths: [`${sandboxRelPath}/candidate.txt`],
			truncated: true,
		});

		const byteLimits = getToolResourceLimits("standard");
		const byteRunner = createGlobRunner({
			search: async () => ({
				paths: [`${sandboxRelPath}/candidate.txt`],
			}),
		});
		await expect(
			byteRunner(
				{ path: sandboxRelPath, pattern: "*.txt" },
				{
					resourceLimits: {
						...byteLimits,
						glob: { ...byteLimits.glob, maxOutputBytes: 16 },
					},
				}
			)
		).resolves.toEqual({ paths: [], truncated: true });
	});
	test("rejects glob scopes outside the workspace", async () => {
		await expect(
			runGlobTool({ path: outsidePath, pattern: "*" })
		).rejects.toThrow(`Path escapes workspace: ${outsidePath}`);
		await expect(
			runGlobTool({ path: "../../etc", pattern: "*" })
		).rejects.toThrow("Path escapes workspace: ../../etc");

		const outsideFile = path.join(outsidePath, "outside.txt");
		writeFileSync(outsideFile, "outside");
		symlinkSync(outsideFile, path.join(sandboxPath, "outside-link.txt"));
		await expect(
			runGlobTool({
				includeHidden: true,
				path: sandboxRelPath,
				pattern: "*.txt",
			})
		).resolves.toEqual({ paths: [] });
	});
	test("finds setUserLocale when a model sends the ripgrep line flag", async () => {
		writeFileSync(path.join(sandboxPath, "locale.ts"), "setUserLocale\n");
		const input = {
			flags: "n",
			path: sandboxRelPath,
			pattern: "setUserLocale",
		};

		await expect(runGrepTool(input)).resolves.toEqual({
			matches: [
				{
					line: "setUserLocale",
					lineNumber: 1,
					path: `${sandboxRelPath}/locale.ts`,
				},
			],
		});
	});
	test("passes option-like patterns through native grep safely", async () => {
		writeFileSync(path.join(sandboxPath, "option.txt"), "--hidden\n");

		await expect(
			runGrepTool({ path: sandboxRelPath, pattern: "--hidden" })
		).resolves.toEqual({
			matches: [
				{
					line: "--hidden",
					lineNumber: 1,
					path: `${sandboxRelPath}/option.txt`,
				},
			],
		});
	});
	test("falls back to JavaScript search when ripgrep is unavailable", async () => {
		writeFileSync(path.join(sandboxPath, "fallback.ts"), "needle\n");
		const runGrepWithUnavailableRipgrep = createGrepRunner({
			search: async () => {
				throw new RipgrepUnavailableError("missing-rg");
			},
		});

		await expect(
			runGrepWithUnavailableRipgrep({
				path: sandboxRelPath,
				pattern: "needle",
			})
		).resolves.toEqual({
			matches: [
				{
					line: "needle",
					lineNumber: 1,
					path: `${sandboxRelPath}/fallback.ts`,
				},
			],
		});
	});
	test("falls back for JavaScript regex unsupported by ripgrep", async () => {
		writeFileSync(path.join(sandboxPath, "lookbehind.ts"), "needlehit\n");

		await expect(
			runGrepTool({
				path: sandboxRelPath,
				pattern: "(?<=needle)hit",
			})
		).resolves.toEqual({
			matches: [
				{
					line: "needlehit",
					lineNumber: 1,
					path: `${sandboxRelPath}/lookbehind.ts`,
				},
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
	test("uses an elevated resource profile for larger search files", async () => {
		const filePath = `${sandboxRelPath}/large-search.txt`;
		writeFileSync(
			path.join(workspace, filePath),
			`needle\n${"x".repeat(2 * 1024 * 1024)}`
		);

		await expect(
			runGrepTool(
				{ pattern: "needle", path: sandboxRelPath },
				{ resourceLimits: getToolResourceLimits("standard") }
			)
		).resolves.toEqual({ matches: [] });
		await expect(
			runGrepTool(
				{ pattern: "needle", path: sandboxRelPath },
				{ resourceLimits: getToolResourceLimits("extended") }
			)
		).resolves.toEqual({
			matches: [
				{
					line: "needle",
					lineNumber: 1,
					path: filePath,
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
