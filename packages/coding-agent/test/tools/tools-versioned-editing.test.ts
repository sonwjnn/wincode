import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type {
	FileObservationStore,
	VersionedEditingContext,
} from "@/modules/tools";
import {
	computeFileVersion,
	createMemoryFileObservationStore,
	decodeEscapedPatchPath,
	decodeLosslessText,
	editInputSchema,
	encodeLosslessText,
	FILE_VERSION_ALGORITHM,
	getToolResourceLimits,
	runEditTool,
	runReadTool,
	runWriteTool,
} from "@/modules/tools";

const withTempFile = async <T>(
	content: string,
	callback: (filePath: string, context: VersionedEditingContext) => Promise<T>
): Promise<T> => {
	const directory = await mkdtemp("/tmp/wincode-versioned-");
	const filePath = path.join(directory, "sample.txt");
	const context: VersionedEditingContext = {
		editMode: "hashline",
		sessionId: "test-session",
		store: createMemoryFileObservationStore(),
	};
	try {
		await globalThis.Bun.write(filePath, content);
		return await callback(filePath, context);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
};
const FILE_VERSION_PATTERN = /^[0-9a-f]{32}$/u;
describe("versioned text model", () => {
	test("hashes exact bytes and preserves BOM, mixed endings, and EOF state", () => {
		const bytes = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...new TextEncoder().encode("one\r\ntwo\nthree"),
		]);
		const text = decodeLosslessText(bytes);

		expect(FILE_VERSION_ALGORITHM).toBe("sha256-128");
		expect(computeFileVersion(bytes)).toHaveLength(32);
		expect(text.hasBom).toBe(true);
		expect(text.lines.map((line) => [line.text, line.ending])).toEqual([
			["one", "\r\n"],
			["two", "\n"],
			["three", ""],
		]);
		expect(encodeLosslessText(text)).toEqual(bytes);
	});

	test("does not create a phantom line after a trailing newline", () => {
		const text = decodeLosslessText(new TextEncoder().encode("a\n\n"));

		expect(text.lines.map((line) => line.text)).toEqual(["a", ""]);
		expect(text.lines.at(-1)?.ending).toBe("\n");
	});

	test("rejects invalid UTF-8 and NUL-bearing content", () => {
		expect(() => decodeLosslessText(new Uint8Array([0xc3, 0x28]))).toThrow(
			"invalid UTF-8"
		);
		expect(() =>
			decodeLosslessText(new TextEncoder().encode("safe\0text"))
		).toThrow("NUL");
	});

	test("decodes bracket escapes and rejects raw closing brackets", () => {
		expect(decodeEscapedPatchPath("/tmp/a\\]b")).toBe("/tmp/a]b");
		expect(decodeEscapedPatchPath("/tmp/a]b")).toBeUndefined();
	});
	test("rejects legacy Edit shapes with actionable guidance", () => {
		const fullFile = editInputSchema.safeParse({
			content: "replacement",
			path: "sample.txt",
		});
		expect(fullFile.success).toBe(false);
		if (!fullFile.success) {
			expect(fullFile.error.issues[0]?.message).toContain(
				"use Write with an expected File Version"
			);
		}
		const legacyReplacement = editInputSchema.safeParse({
			find: "old",
			path: "sample.txt",
			replace: "new",
		});
		expect(legacyReplacement.success).toBe(false);
		if (!legacyReplacement.success) {
			expect(legacyReplacement.error.issues[0]?.message).toContain(
				"active Edit Mode patch protocol"
			);
		}
	});
});
describe("versioned coding tools", () => {
	test("read returns a stable version and continuation rejects drift", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const first = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const version = first.fileVersion as string;
			expect(version).toMatch(FILE_VERSION_PATTERN);
			expect(first.seenLines).toEqual([{ endLine: 2, startLine: 1 }]);
			await globalThis.Bun.write(filePath, "changed\ntwo\n");
			await expect(
				runReadTool(
					{ expectedVersion: version, path: filePath },
					{ allowExternalPath: true, versionedEditing: context }
				)
			).rejects.toMatchObject({ code: "file-version-mismatch" });
		});
	});

	test("requires a File Version for subsequent text reads", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const first = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await expect(
				runReadTool(
					{ path: filePath },
					{ allowExternalPath: true, versionedEditing: context }
				)
			).rejects.toMatchObject({
				code: "expected-file-version",
				recovery: { action: "provide-file-version" },
			});
			await globalThis.Bun.write(filePath, "changed\ntwo\n");
			await expect(
				runReadTool(
					{
						expectedVersion: first.fileVersion as string,
						path: filePath,
					},
					{ allowExternalPath: true, versionedEditing: context }
				)
			).rejects.toMatchObject({ code: "file-version-mismatch" });
		});
	});
	test("bounded reads expose continuation ranges and reject an unfit first line", async () => {
		await withTempFile("first\nsecond\n", async (filePath, context) => {
			const standard = getToolResourceLimits();
			const limited = {
				...standard,
				read: { ...standard.read, maxOutputBytes: 7 },
			};
			const first = await runReadTool(
				{ path: filePath },
				{
					allowExternalPath: true,
					resourceLimits: limited,
					versionedEditing: context,
				}
			);
			expect(first.truncated).toBe(true);
			expect(first.continuationRanges).toEqual([{ endLine: 2, startLine: 2 }]);
			await expect(
				runReadTool(
					{
						expectedVersion: first.fileVersion as string,
						fullLines: true,
						path: filePath,
					},
					{
						allowExternalPath: true,
						resourceLimits: {
							...standard,
							read: { ...standard.read, maxOutputBytes: 6 },
						},
						versionedEditing: context,
					}
				)
			).rejects.toMatchObject({
				code: "read-output-out-of-budget",
				details: { lineRange: { startLine: 1 } },
			});
		});
	});
	test("continuation includes a displayed line truncated in the middle", async () => {
		await withTempFile("one\n0123456789\nlast\n", async (filePath, context) => {
			const standard = getToolResourceLimits();
			const result = await runReadTool(
				{ path: filePath },
				{
					allowExternalPath: true,
					resourceLimits: {
						...standard,
						read: {
							...standard.read,
							maxLineBytes: 4,
							maxOutputBytes: 100,
						},
					},
					versionedEditing: context,
				}
			);
			expect(result.seenLines).toEqual([{ startLine: 1 }, { startLine: 3 }]);
			expect(result.continuationRanges).toEqual([{ endLine: 3, startLine: 2 }]);
		});
	});

	test("continuation rejects a text observation after the path becomes a directory", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			const first = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await rm(filePath);
			await mkdir(filePath);
			await expect(
				runReadTool(
					{
						expectedVersion: first.fileVersion as string,
						path: filePath,
					},
					{ allowExternalPath: true, versionedEditing: context }
				)
			).rejects.toMatchObject({ code: "file-version-mismatch" });
		});
	});

	test("truncated lines are displayed but not authorized for edits", async () => {
		await withTempFile(
			`${"x".repeat(600)}\nshort\n`,
			async (filePath, context) => {
				const standard = getToolResourceLimits();
				const limited = {
					...standard,
					read: { ...standard.read, maxLineBytes: 32 },
				};
				const truncated = await runReadTool(
					{ path: filePath },
					{
						allowExternalPath: true,
						resourceLimits: limited,
						versionedEditing: context,
					}
				);
				expect(truncated.content).toContain("…");
				expect(truncated.truncated).toBe(true);
				expect(truncated.seenLines).toEqual([{ startLine: 2 }]);
				const complete = await runReadTool(
					{
						expectedVersion: truncated.fileVersion as string,
						fullLines: true,
						path: filePath,
					},
					{
						allowExternalPath: true,
						resourceLimits: limited,
						versionedEditing: context,
					}
				);
				expect(complete.seenLines).toEqual([{ endLine: 2, startLine: 1 }]);
			}
		);
	});
	test("rejects observations beyond the configured line budget", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const standard = getToolResourceLimits();
			const limited = {
				...standard,
				read: { ...standard.read, maxObservedLines: 1 },
			};
			await expect(
				runReadTool(
					{ fullLines: true, path: filePath },
					{
						allowExternalPath: true,
						resourceLimits: limited,
						versionedEditing: context,
					}
				)
			).rejects.toMatchObject({
				code: "observation-out-of-budget",
				recovery: { action: "reread" },
			});
		});
	});

	test("conservatively maps a target after unrelated live drift", async () => {
		await withTempFile("one\ntwo\nthree\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath, fullLines: true },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await globalThis.Bun.write(filePath, "zero\none\ntwo\nthree\n");
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nPUT 2.=2:\n+TWO`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"zero\none\nTWO\nthree\n"
			);
		});
	});

	test("maps a target when unrelated drift follows it", async () => {
		await withTempFile("one\ntwo\nthree\nfour\n", async (filePath, context) => {
			const read = await runReadTool(
				{ fullLines: true, path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await globalThis.Bun.write(filePath, "one\ntwo\nthree\nchanged\n");
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nPUT 2.=2:\n+TWO`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"one\nTWO\nthree\nchanged\n"
			);
		});
	});

	test("maps the first target across unrelated prefix drift", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const read = await runReadTool(
				{ fullLines: true, path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await globalThis.Bun.write(filePath, "zero\none\ntwo\n");
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nPUT 1.=1:\n+ONE`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"zero\nONE\ntwo\n"
			);
		});
	});
	test("does not remap changed observed lines onto later duplicates", async () => {
		await withTempFile(
			"A\nB\nC\nD\nE\nF\nG\nX\nZ\nQ\nR\nS\n",
			async (filePath, context) => {
				const read = await runReadTool(
					{ fullLines: false, path: `${filePath}:1-1,8-8` },
					{ allowExternalPath: true, versionedEditing: context }
				);
				await globalThis.Bun.write(
					filePath,
					"A\nB\nC\nD\nE\nF\nG\nY\nZ\nQ\nR\nX\nS\n"
				);
				const result = await runEditTool(
					{
						patch: `[${filePath}#${read.fileVersion as string}]\nPUT 1.=1:\n+AA`,
					},
					{ allowExternalPath: true, versionedEditing: context }
				);
				expect(result.seenLines).toEqual([
					{ endLine: 4, startLine: 1 },
					{ startLine: 7 },
					{ endLine: 11, startLine: 9 },
				]);
				await expect(
					runEditTool(
						{
							patch: `[${filePath}#${result.newFileVersion}]\nPUT 12.=12:\n+XX`,
						},
						{ allowExternalPath: true, versionedEditing: context }
					)
				).rejects.toMatchObject({ code: "unseen-lines" });
			}
		);
	});
	test("insert-before preserves the separator before an unterminated line", async () => {
		await withTempFile("a", async (filePath, context) => {
			const read = await runReadTool(
				{ fullLines: true, path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nPUT <1:\n+x`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe("x\na");
		});
	});

	test("rejects a target replaced by a duplicate created during drift", async () => {
		await withTempFile(
			"P\nA\nB\nQ\nP\nC\nD\nQ\n",
			async (filePath, context) => {
				const read = await runReadTool(
					{ fullLines: true, path: filePath },
					{ allowExternalPath: true, versionedEditing: context }
				);
				await globalThis.Bun.write(filePath, "P\nA\nX\nQ\nP\nA\nB\nQ\n");
				await expect(
					runEditTool(
						{
							patch: `[${filePath}#${read.fileVersion as string}]\nPUT 2.=3:\n+AA`,
						},
						{ allowExternalPath: true, versionedEditing: context }
					)
				).rejects.toMatchObject({ code: "stale-edit" });
				expect(await globalThis.Bun.file(filePath).text()).toBe(
					"P\nA\nX\nQ\nP\nA\nB\nQ\n"
				);
			}
		);
	});
	test("rejects drift at a hashline insertion boundary", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const read = await runReadTool(
				{ fullLines: true, path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await globalThis.Bun.write(filePath, "one\nexternal\ntwo\n");
			await expect(
				runEditTool(
					{
						patch: `[${filePath}#${read.fileVersion as string}]\nPUT >1:\n+new`,
					},
					{ allowExternalPath: true, versionedEditing: context }
				)
			).rejects.toMatchObject({ code: "stale-edit" });
		});
	});

	test("rejects edits to read-only files before replacement", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			await chmod(filePath, 0o444);
			try {
				const read = await runReadTool(
					{ fullLines: true, path: filePath },
					{ allowExternalPath: true, versionedEditing: context }
				);
				await expect(
					runEditTool(
						{
							patch: `[${filePath}#${read.fileVersion as string}]\nPUT 1.=1:\n+ONE`,
						},
						{ allowExternalPath: true, versionedEditing: context }
					)
				).rejects.toMatchObject({ code: "file-not-writable" });
				expect(await globalThis.Bun.file(filePath).text()).toBe("one\n");
			} finally {
				await chmod(filePath, 0o644);
			}
		});
	});

	test("hashline edit preserves untouched bytes and records the new observation", async () => {
		await withTempFile("one\r\ntwo\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const version = read.fileVersion as string;
			const result = await runEditTool(
				{
					patch: `[${filePath}#${version}]\nPUT 1.=1:\n+ONE`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(result.newFileVersion).toMatch(FILE_VERSION_PATTERN);
			expect(result.oldFileVersion).toBe(read.fileVersion);
			expect(await globalThis.Bun.file(filePath).bytes()).toEqual(
				new TextEncoder().encode("ONE\r\ntwo\n")
			);
		});
	});

	test("replace normalizes matching endings without rewriting untouched bytes", async () => {
		await withTempFile("one\r\ntwo\r\nthree\n", async (filePath, context) => {
			await runReadTool(
				{ path: filePath, fullLines: true },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					mode: "replace",
					newString: "TWO",
					oldString: "two",
					path: filePath,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "replace" },
				}
			);
			expect(await globalThis.Bun.file(filePath).bytes()).toEqual(
				new TextEncoder().encode("one\r\nTWO\r\nthree\n")
			);
		});
	});

	test("replace Seen Lines exclude the trailing newline phantom", async () => {
		await withTempFile("one\ntwo\nthree\n", async (filePath, context) => {
			const result = await runEditTool(
				{
					mode: "replace",
					newString: "TWO\nNEW\n",
					oldString: "two\n",
					path: filePath,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "replace" },
				}
			);
			expect(result.seenLines).toEqual([{ endLine: 3, startLine: 2 }]);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"one\nTWO\nNEW\nthree\n"
			);
		});
	});

	test("replace carries previously observed untouched lines", async () => {
		await withTempFile("one\ntwo\nthree\n", async (filePath, context) => {
			await runReadTool(
				{ fullLines: true, path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const result = await runEditTool(
				{
					mode: "replace",
					newString: "TWO",
					oldString: "two",
					path: filePath,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "replace" },
				}
			);
			expect(result.seenLines).toEqual([{ endLine: 3, startLine: 1 }]);
		});
	});
	test("replace does not authorize untouched bytes on a merged line", async () => {
		await withTempFile("a\nb\n", async (filePath, context) => {
			const result = await runEditTool(
				{
					mode: "replace",
					newString: "a",
					oldString: "a\n",
					path: filePath,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "replace" },
				}
			);
			expect(result.seenLines).toEqual([]);
			await expect(
				runEditTool(
					{
						patch: `[${filePath}#${result.newFileVersion}]\nPUT 1.=1:\n+AB`,
					},
					{
						allowExternalPath: true,
						versionedEditing: { ...context, editMode: "hashline" },
					}
				)
			).rejects.toMatchObject({ code: "unseen-lines" });
		});
	});
	test("replace drops observed lines absorbed by a merged neighbor", async () => {
		await withTempFile("a\nb\nc\n", async (filePath, context) => {
			await runReadTool(
				{ fullLines: true, path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const result = await runEditTool(
				{
					mode: "replace",
					newString: "X",
					oldString: "a\n",
					path: filePath,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "replace" },
				}
			);
			expect(result.seenLines).toEqual([{ startLine: 2 }]);
			expect(await globalThis.Bun.file(filePath).text()).toBe("Xb\nc\n");
		});
	});

	test("replace rejects overlapping matches as ambiguous by default", async () => {
		await withTempFile("aaa", async (filePath, context) => {
			await expect(
				runEditTool(
					{
						mode: "replace",
						newString: "b",
						oldString: "aa",
						path: filePath,
					},
					{
						allowExternalPath: true,
						versionedEditing: { ...context, editMode: "replace" },
					}
				)
			).rejects.toMatchObject({ code: "replacement-ambiguous" });
			expect(await globalThis.Bun.file(filePath).text()).toBe("aaa");
		});
	});

	test("replace preserves a missing final newline", async () => {
		await withTempFile("one\ntwo", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath, fullLines: true },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					mode: "replace",
					newString: "TWO",
					oldString: "two",
					path: filePath,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "replace" },
				}
			);
			expect(read.fileVersion).toMatch(FILE_VERSION_PATTERN);
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\nTWO");
		});
	});

	test("hashline preserves CR-only endings", async () => {
		await withTempFile("one\rtwo\r", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath, fullLines: true },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nPUT 1.=1:\n+ONE`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe("ONE\rtwo\r");
		});
	});

	test("hashline insertion after an EOF-newline anchor keeps the EOF newline", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nPUT >1:\n+two`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\ntwo\n");
		});
	});

	test("hashline insertion preserves a missing final newline", async () => {
		await withTempFile("one", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nPUT >1:\n+two`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\ntwo");
		});
	});

	test("hashline CUT removes the verified line without changing neighbors", async () => {
		await withTempFile("one\ntwo\nthree\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion}]\nCUT 2.=2`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\nthree\n");
		});
	});
	test("sloppy resolves all hunks against original content", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const patch = [
				"*** Begin Patch",
				`*** Update File: ${filePath}`,
				"@@ -1,1 +1,1 @@",
				"-one",
				"+inserted",
				"@@ -2,1 +2,1 @@",
				"-inserted",
				"+should-not-apply",
				"*** End Patch",
			].join("\n");
			await expect(
				runEditTool(
					{ mode: "sloppy", patch },
					{
						allowExternalPath: true,
						allowSloppy: true,
						versionedEditing: { ...context, editMode: "sloppy" },
					}
				)
			).rejects.toMatchObject({ code: "sloppy-no-match" });
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\ntwo\n");
		});
	});
	test("sloppy hunk hints do not break repeated-context ambiguity", async () => {
		await withTempFile("same\none\nsame\n", async (filePath, context) => {
			await expect(
				runEditTool(
					{
						mode: "sloppy",
						patch: [
							"*** Begin Patch",
							`*** Update File: ${filePath}`,
							"@@ -3,1 +3,1 @@",
							"-same",
							"+third",
							"*** End Patch",
						].join("\n"),
					},
					{
						allowExternalPath: true,
						allowSloppy: true,
						versionedEditing: { ...context, editMode: "sloppy" },
					}
				)
			).rejects.toMatchObject({ code: "sloppy-ambiguous" });
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"same\none\nsame\n"
			);
		});
	});
	test("sloppy edits preserve previously observed untouched lines", async () => {
		await withTempFile("one\ntwo\nthree\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const sloppy = await runEditTool(
				{
					mode: "sloppy",
					patch: [
						"*** Begin Patch",
						`*** Update File: ${filePath}`,
						"@@",
						"-two",
						"+TWO",
						"*** End Patch",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					allowSloppy: true,
					versionedEditing: { ...context, editMode: "sloppy" },
				}
			);
			await runEditTool(
				{
					patch: `[${filePath}#${sloppy.newFileVersion as string}]\nPUT 3.=3:\n+THREE`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"one\nTWO\nTHREE\n"
			);
			expect(read.seenLines).toEqual([{ endLine: 3, startLine: 1 }]);
		});
	});

	test("hashline CUT preserves a missing final newline", async () => {
		await withTempFile("one\ntwo", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					patch: `[${filePath}#${read.fileVersion as string}]\nCUT 2.=2`,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe("one");
		});
	});

	test("rejects a mode that is not active for the turn", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			await expect(
				runEditTool(
					{
						mode: "replace",
						newString: "ONE",
						oldString: "one",
						path: filePath,
					},
					{ allowExternalPath: true, versionedEditing: context }
				)
			).rejects.toMatchObject({ code: "edit-mode-mismatch" });
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\n");
		});
	});

	test("returns a structured failure before mutation when diff exceeds budget", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			const limits = getToolResourceLimits();
			const constrained = {
				...limits,
				edit: {
					...limits.edit,
					maxDiffBytes: 1,
					maxDiffLines: 1,
					maxFullDiffArtifactBytes: 1,
				},
			};
			await expect(
				runEditTool(
					{
						mode: "replace",
						newString: "ONE",
						oldString: "one",
						path: filePath,
					},
					{
						allowExternalPath: true,
						resourceLimits: constrained,
						versionedEditing: { ...context, editMode: "replace" },
					}
				)
			).rejects.toMatchObject({ code: "edit-diff-artifact-out-of-budget" });
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\n");
		});
	});
	test("rejects patch input over budget before parsing or mutation", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			const limits = getToolResourceLimits();
			const constrained = {
				...limits,
				edit: { ...limits.edit, maxPatchBytes: 8 },
			};
			await expect(
				runEditTool(
					{ patch: "x".repeat(9) },
					{
						allowExternalPath: true,
						resourceLimits: constrained,
						versionedEditing: context,
					}
				)
			).rejects.toMatchObject({ code: "edit-input-out-of-budget" });
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\n");
		});
	});
	test("sloppy normalization preserves live context bytes", async () => {
		await withTempFile("  one\nremove\n", async (filePath, context) => {
			await runEditTool(
				{
					mode: "sloppy",
					patch: [
						"*** Begin Patch",
						`*** Update File: ${filePath}`,
						"@@",
						" one",
						"-remove",
						"+done",
						"*** End Patch",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					allowSloppy: true,
					versionedEditing: { ...context, editMode: "sloppy" },
				}
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe("  one\ndone\n");
		});
	});

	test("write requires an expected version when overwriting", async () => {
		await withTempFile("old\n", async (filePath, context) => {
			await expect(
				runWriteTool(
					{ content: "new\n", path: filePath },
					{ allowExternalPath: true, versionedEditing: context }
				)
			).rejects.toMatchObject({ code: "expected-file-version" });
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const result = await runWriteTool(
				{
					content: "new\n",
					expectedVersion: read.fileVersion as string,
					path: filePath,
				},
				{ allowExternalPath: true, versionedEditing: context }
			);
			expect(result.oldFileVersion).toBe(read.fileVersion);
			expect(await globalThis.Bun.file(filePath).text()).toBe("new\n");
		});
	});
	test("patch applies multiple disjoint hunks atomically from one snapshot", async () => {
		await withTempFile("one\ntwo\nthree\nfour\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const result = await runEditTool(
				{
					mode: "patch",
					patch: [
						`[${filePath}#${read.fileVersion}]`,
						"PUT 1.=1:",
						"+ONE",
						"PUT 3.=3:",
						"+THREE",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "patch" },
				}
			);
			expect(result.files?.[0]?.hunkCount).toBe(2);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"ONE\ntwo\nTHREE\nfour\n"
			);
		});
	});

	test("apply_patch deduplicates repeated same-version sections across files", async () => {
		await withTempFile("one\nthree\n", async (firstPath, context) => {
			const secondPath = path.join(path.dirname(firstPath), "second.txt");
			await globalThis.Bun.write(secondPath, "alpha\nbeta\n");
			const firstRead = await runReadTool(
				{ path: firstPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const secondRead = await runReadTool(
				{ path: secondPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const result = await runEditTool(
				{
					mode: "apply_patch",
					patch: [
						"*** Begin Patch",
						`[${firstPath}#${firstRead.fileVersion}]`,
						"PUT 1.=1:",
						"+ONE",
						`[${secondPath}#${secondRead.fileVersion}]`,
						"PUT 1.=1:",
						"+ALPHA",
						"*** End Patch",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "apply_patch" },
				}
			);
			expect(result.files).toHaveLength(2);
			expect(await globalThis.Bun.file(firstPath).text()).toBe("ONE\nthree\n");
			expect(await globalThis.Bun.file(secondPath).text()).toBe(
				"ALPHA\nbeta\n"
			);
		});
	});
	test("merges canonical and symlink aliases into one committed file", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const aliasPath = path.join(path.dirname(filePath), "alias.txt");
			await symlink(filePath, aliasPath);
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const result = await runEditTool(
				{
					mode: "apply_patch",
					patch: [
						`[${filePath}#${read.fileVersion}]`,
						"PUT 1.=1:",
						"+ONE",
						`[${aliasPath}#${read.fileVersion}]`,
						"PUT 2.=2:",
						"+TWO",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "apply_patch" },
				}
			);
			expect(result.files).toHaveLength(1);
			expect(result.files?.[0]?.hunkCount).toBe(2);
			expect(await globalThis.Bun.file(filePath).text()).toBe("ONE\nTWO\n");
		});
	});
	test("rejects an approved symlink retarget before editing", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const aliasPath = path.join(path.dirname(filePath), "alias.txt");
			const replacementPath = path.join(
				path.dirname(filePath),
				"replacement.txt"
			);
			await globalThis.Bun.write(replacementPath, "outside\n");
			await symlink(filePath, aliasPath);
			const read = await runReadTool(
				{ fullLines: true, path: aliasPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await rm(aliasPath);
			await symlink(replacementPath, aliasPath);
			await expect(
				runEditTool(
					{
						patch: `[${aliasPath}#${read.fileVersion}]\nPUT 1.=1:\n+ONE`,
					},
					{
						allowExternalPath: true,
						approvedExternalPaths: [filePath],
						versionedEditing: context,
					}
				)
			).rejects.toMatchObject({ code: "approved-path-changed" });
			expect(await globalThis.Bun.file(replacementPath).text()).toBe(
				"outside\n"
			);
		});
	});
	test("preserves observed lines across unrelated apply_patch drift", async () => {
		await withTempFile("one\ntwo\nthree\nfour\n", async (filePath, context) => {
			const read = await runReadTool(
				{ fullLines: true, path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await globalThis.Bun.write(filePath, "zero\none\ntwo\nthree\nfour\n");
			const first = await runEditTool(
				{
					mode: "apply_patch",
					patch: `[${filePath}#${read.fileVersion}]\nPUT 3.=3:\n+THREE`,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "apply_patch" },
				}
			);
			const newVersion = first.files?.[0]?.newFileVersion;
			expect(newVersion).toBeString();
			await runEditTool(
				{
					mode: "apply_patch",
					patch: `[${filePath}#${newVersion}]\nPUT 2.=2:\n+ONE`,
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "apply_patch" },
				}
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"zero\nONE\ntwo\nTHREE\nfour\n"
			);
		});
	});
	test("acquires the complete canonical lease set in sorted order", async () => {
		await withTempFile("one\n", async (firstPath, context) => {
			const secondPath = path.join(path.dirname(firstPath), "a.txt");
			await globalThis.Bun.write(secondPath, "two\n");
			const firstRead = await runReadTool(
				{ path: firstPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const secondRead = await runReadTool(
				{ path: secondPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const baseStore = context.store;
			let leasePaths: readonly string[] = [];
			const leaseStore: FileObservationStore = {
				...baseStore,
				withPathLeases: async (paths, operation) => {
					leasePaths = [...paths];
					return (
						baseStore.withPathLeases?.(paths, operation) ??
						operation(() => undefined)
					);
				},
			};
			await runEditTool(
				{
					mode: "apply_patch",
					patch: [
						`[${firstPath}#${firstRead.fileVersion}]`,
						"PUT 1.=1:",
						"+ONE",
						`[${secondPath}#${secondRead.fileVersion}]`,
						"PUT 1.=1:",
						"+TWO",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					versionedEditing: {
						...context,
						editMode: "apply_patch",
						store: leaseStore,
					},
				}
			);
			const expectedLeasePaths = await Promise.all(
				[firstPath, secondPath].map((candidate) => realpath(candidate))
			);
			expect(leasePaths).toEqual(expectedLeasePaths.sort());
		});
	});

	test("repeated sections with different versions fail before any write", async () => {
		await withTempFile("one\nthree\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await expect(
				runEditTool(
					{
						mode: "apply_patch",
						patch: [
							`[${filePath}#${read.fileVersion}]`,
							"PUT 1.=1:",
							"+ONE",
							`[${filePath}#${"0".repeat(32)}]`,
							"PUT 2.=2:",
							"+THREE",
						].join("\n"),
					},
					{
						allowExternalPath: true,
						versionedEditing: { ...context, editMode: "apply_patch" },
					}
				)
			).rejects.toMatchObject({ code: "version-conflict" });
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\nthree\n");
		});
	});

	test("overlapping multi-hunks fail before mutation", async () => {
		await withTempFile("one\ntwo\nthree\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await expect(
				runEditTool(
					{
						mode: "patch",
						patch: [
							`[${filePath}#${read.fileVersion}]`,
							"PUT 1.=2:",
							"+ONE",
							"+TWO",
							"PUT 2.=3:",
							"+TWO",
							"+THREE",
						].join("\n"),
					},
					{
						allowExternalPath: true,
						versionedEditing: { ...context, editMode: "patch" },
					}
				)
			).rejects.toMatchObject({ code: "hunk-overlap" });
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"one\ntwo\nthree\n"
			);
		});
	});

	test("rechecks live versions after preparation before replacement", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const baseStore = context.store;
			let raced = false;
			const raceStore: FileObservationStore = {
				...baseStore,
				saveSnapshot: async (snapshot) => {
					await baseStore.saveSnapshot(snapshot);
					if (!raced) {
						raced = true;
						await globalThis.Bun.write(filePath, "raced\n");
					}
				},
			};
			await expect(
				runEditTool(
					{
						mode: "patch",
						patch: [
							`[${filePath}#${read.fileVersion}]`,
							"PUT 1.=1:",
							"+ONE",
						].join("\n"),
					},
					{
						allowExternalPath: true,
						versionedEditing: {
							...context,
							editMode: "patch",
							store: raceStore,
						},
					}
				)
			).rejects.toMatchObject({ code: "file-version-mismatch" });
			expect(await globalThis.Bun.file(filePath).text()).toBe("raced\n");
		});
	});
	test("rolls back earlier files when a later replacement fails", async () => {
		await withTempFile("one\n", async (firstPath, context) => {
			const secondPath = path.join(path.dirname(firstPath), "second.txt");
			await globalThis.Bun.write(secondPath, "two\n");
			const firstRead = await runReadTool(
				{ path: firstPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const secondRead = await runReadTool(
				{ path: secondPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await chmod(secondPath, 0o444);
			await expect(
				runEditTool(
					{
						mode: "apply_patch",
						patch: [
							`[${firstPath}#${firstRead.fileVersion}]`,
							"PUT 1.=1:",
							"+ONE",
							`[${secondPath}#${secondRead.fileVersion}]`,
							"PUT 1.=1:",
							"+TWO",
						].join("\n"),
					},
					{
						allowExternalPath: true,
						versionedEditing: { ...context, editMode: "apply_patch" },
					}
				)
			).rejects.toMatchObject({ code: "file-not-writable" });
			expect(await globalThis.Bun.file(firstPath).text()).toBe("one\n");
			expect(await globalThis.Bun.file(secondPath).text()).toBe("two\n");
		});
	});
	test("same-boundary insertions preserve declaration order", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					mode: "patch",
					patch: [
						`[${filePath}#${read.fileVersion}]`,
						"PUT >1:",
						"+A",
						"PUT <2:",
						"+B",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "patch" },
				}
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"one\nA\nB\ntwo\n"
			);
		});
	});
	test("allows insertion immediately after a changed range", async () => {
		await withTempFile("one\ntwo\nthree\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			await runEditTool(
				{
					mode: "patch",
					patch: [
						`[${filePath}#${read.fileVersion}]`,
						"PUT 1.=2:",
						"+ONE",
						"+TWO",
						"PUT >2:",
						"+AFTER",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					versionedEditing: { ...context, editMode: "patch" },
				}
			);
			expect(await globalThis.Bun.file(filePath).text()).toBe(
				"ONE\nTWO\nAFTER\nthree\n"
			);
		});
	});
	test("rejects unauditable full diffs before mutation", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const standard = getToolResourceLimits();
			await expect(
				runEditTool(
					{
						mode: "patch",
						patch: [
							`[${filePath}#${read.fileVersion}]`,
							"PUT 1.=1:",
							"+ONE",
						].join("\n"),
					},
					{
						allowExternalPath: true,
						resourceLimits: {
							...standard,
							edit: {
								...standard.edit,
								maxDiffBytes: 1,
								maxDiffLines: 1,
								maxFullDiffArtifactBytes: 1,
							},
						},
						versionedEditing: { ...context, editMode: "patch" },
					}
				)
			).rejects.toMatchObject({
				code: "edit-diff-artifact-out-of-budget",
			});
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\ntwo\n");
		});
	});
	test("large inline diffs spill to a session-scoped artifact", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const standard = getToolResourceLimits();
			const result = await runEditTool(
				{
					mode: "patch",
					patch: [
						`[${filePath}#${read.fileVersion}]`,
						"PUT 1.=1:",
						"+ONE",
					].join("\n"),
				},
				{
					allowExternalPath: true,
					resourceLimits: {
						...standard,
						edit: {
							...standard.edit,
							maxDiffBytes: 1,
							maxDiffLines: 1,
							maxFullDiffArtifactBytes: 10_000,
						},
					},
					versionedEditing: { ...context, editMode: "patch" },
				}
			);
			const artifact = result.files?.[0]?.fullDiffArtifact;
			expect(artifact?.id).toBeString();
			expect(
				await context.store.getFullDiffArtifact?.(
					context.sessionId,
					artifact?.id as string
				)
			).toMatchObject({ id: artifact?.id });
			const artifactRead = await runReadTool(
				{ path: `artifact://${artifact?.id}:1-` },
				{ versionedEditing: context }
			);
			expect(artifactRead.content).toContain("-one");
		});
	});
	test("replace spills a large diff into the same artifact channel", async () => {
		await withTempFile("one\n", async (filePath, context) => {
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const standard = getToolResourceLimits();
			const result = await runEditTool(
				{
					mode: "replace",
					newString: "ONE",
					oldString: "one",
					path: filePath,
				},
				{
					allowExternalPath: true,
					resourceLimits: {
						...standard,
						edit: {
							...standard.edit,
							maxDiffBytes: 1,
							maxDiffLines: 1,
							maxFullDiffArtifactBytes: 10_000,
						},
					},
					versionedEditing: { ...context, editMode: "replace" },
				}
			);
			expect(result.fullDiffArtifact?.id).toBeString();
			expect(result.newFileVersion).not.toBe(read.fileVersion);
			expect(await globalThis.Bun.file(filePath).text()).toBe("ONE\n");
		});
	});
	test("persists unresolved recovery when manifest progress cleanup fails", async () => {
		await withTempFile("one\ntwo\n", async (filePath, context) => {
			const recovery = context.store.recovery;
			if (recovery === undefined) {
				throw new Error("The memory observation store has no recovery store.");
			}
			const failingRecovery = {
				...recovery,
				updateTransactionPath: async () => {
					throw new Error("injected manifest progress failure");
				},
			};
			const failingContext: VersionedEditingContext = {
				...context,
				store: { ...context.store, recovery: failingRecovery },
			};
			const read = await runReadTool(
				{ path: filePath },
				{ allowExternalPath: true, versionedEditing: failingContext }
			);
			let failure: unknown;
			try {
				await runEditTool(
					{
						patch: `[${filePath}#${read.fileVersion}]\nPUT 1.=1:\n+ONE`,
					},
					{ allowExternalPath: true, versionedEditing: failingContext }
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) {
				throw new Error("Expected a structured coding-tool failure.");
			}
			const structuredFailure = failure as Error & {
				code?: string;
				details?: { unresolvedPaths?: string[] };
			};
			expect(structuredFailure.code).toBe("partial_failure");
			expect(structuredFailure.details?.unresolvedPaths).toEqual([
				await realpath(filePath),
			]);
			expect(await globalThis.Bun.file(filePath).text()).toBe("one\ntwo\n");
			expect(await recovery.listUnresolvedRecoveries()).toHaveLength(1);
		});
	});
	test("pins only the path whose rollback is unprovable", async () => {
		const directory = await mkdtemp("/tmp/wincode-versioned-multi-");
		const firstPath = path.join(directory, "first.txt");
		const secondPath = path.join(directory, "second.txt");
		try {
			await globalThis.Bun.write(firstPath, "one\n");
			await globalThis.Bun.write(secondPath, "two\n");
			const baseStore = createMemoryFileObservationStore();
			const recovery = baseStore.recovery;
			if (recovery === undefined) {
				throw new Error("The memory observation store has no recovery store.");
			}
			let committedPaths = 0;
			const failingRecovery = {
				...recovery,
				updateTransactionPath: async (
					transactionId: string,
					canonicalPath: string,
					status: "prepared" | "committed" | "rolled_back" | "unknown"
				) => {
					if (status === "committed") {
						committedPaths += 1;
						if (committedPaths === 2) {
							await globalThis.Bun.write(firstPath, "external\n");
							throw new Error("injected second commit failure");
						}
					}
					await recovery.updateTransactionPath(
						transactionId,
						canonicalPath,
						status
					);
				},
			};
			const context: VersionedEditingContext = {
				editMode: "apply_patch",
				sessionId: "multi-failure-session",
				store: { ...baseStore, recovery: failingRecovery },
			};
			const firstRead = await runReadTool(
				{ path: firstPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			const secondRead = await runReadTool(
				{ path: secondPath },
				{ allowExternalPath: true, versionedEditing: context }
			);
			let failure: unknown;
			try {
				await runEditTool(
					{
						mode: "apply_patch",
						patch: [
							`[${firstPath}#${firstRead.fileVersion}]`,
							"PUT 1.=1:",
							"+ONE",
							`[${secondPath}#${secondRead.fileVersion}]`,
							"PUT 1.=1:",
							"+TWO",
						].join("\n"),
					},
					{ allowExternalPath: true, versionedEditing: context }
				);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error)) {
				throw new Error("Expected a structured coding-tool failure.");
			}
			const structuredFailure = failure as Error & {
				code?: string;
				details?: { unresolvedPaths?: string[] };
			};
			expect(structuredFailure.code).toBe("partial_failure");
			expect(structuredFailure.details?.unresolvedPaths).toEqual([
				await realpath(firstPath),
			]);
			expect(await globalThis.Bun.file(firstPath).text()).toBe("external\n");
			expect(await globalThis.Bun.file(secondPath).text()).toBe("two\n");
			expect(await recovery.listUnresolvedRecoveries()).toHaveLength(1);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
