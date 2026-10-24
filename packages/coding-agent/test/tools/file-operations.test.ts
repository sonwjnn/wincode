import { expect, test } from "bun:test";
import { toolFileOperations } from "@/modules/tools";
import type { FileVersion } from "@/modules/tools/versioned/model";

const version = (seed: string): FileVersion =>
	seed.repeat(32).slice(0, 32) as FileVersion;

test("a completed text Read reports the file it observed", () => {
	expect(
		toolFileOperations("read", {
			content: "1 | hello",
			fileVersion: version("a"),
			path: "src/app.ts",
		})
	).toEqual([{ kind: "read", path: "src/app.ts" }]);
});

test("a directory or symlink Read is not a durable file observation", () => {
	// Neither reports a File Version, so neither can be a text file read.
	expect(toolFileOperations("read", { content: "src/", path: "src" })).toEqual(
		[]
	);
	expect(
		toolFileOperations("read", {
			content: "link -> target",
			path: "link",
		})
	).toEqual([]);
});

test("a completed Write reports the file it modified", () => {
	expect(
		toolFileOperations("write", {
			bytesWritten: 12,
			newFileVersion: version("a"),
			path: "docs/readme.md",
		})
	).toEqual([{ kind: "modified", path: "docs/readme.md" }]);
});

test("a one-file Edit reports the path it committed without a files list", () => {
	// Hashline, replace and sloppy edits use the single-file output shape.
	expect(
		toolFileOperations("edit", {
			newFileVersion: version("a"),
			oldFileVersion: version("b"),
			path: "src/single.ts",
			replacements: 1,
		})
	).toEqual([{ kind: "modified", path: "src/single.ts" }]);
});

test("a completed Edit reports every file it committed", () => {
	expect(
		toolFileOperations("edit", {
			files: [
				{
					hunkCount: 1,
					newFileVersion: version("a"),
					oldFileVersion: version("b"),
					path: "src/a.ts",
					status: "committed",
				},
				{
					hunkCount: 2,
					newFileVersion: version("a"),
					oldFileVersion: version("b"),
					path: "src/b.ts",
					status: "committed",
				},
			],
		})
	).toEqual([
		{ kind: "modified", path: "src/a.ts" },
		{ kind: "modified", path: "src/b.ts" },
	]);
});

test("a batch Edit reports each file once even when a path repeats", () => {
	expect(
		toolFileOperations("edit", {
			files: [
				{
					hunkCount: 1,
					newFileVersion: version("a"),
					oldFileVersion: version("b"),
					path: "src/a.ts",
					status: "committed",
				},
				{
					hunkCount: 1,
					newFileVersion: version("c"),
					oldFileVersion: version("d"),
					path: "src/b.ts",
					status: "committed",
				},
			],
			newFileVersion: version("a"),
			path: "src/a.ts",
		})
	).toEqual([
		{ kind: "modified", path: "src/a.ts" },
		{ kind: "modified", path: "src/b.ts" },
	]);
});

test("failed or contractless tool outputs contribute no file operation", () => {
	// A Shell command may touch any file, so it declares no deterministic path.
	expect(toolFileOperations("shell", { exitCode: 0, output: "ok" })).toEqual(
		[]
	);
	// A partially persisted Edit payload is not a completed output contract.
	expect(toolFileOperations("edit", { files: [{ path: "src/a.ts" }] })).toEqual(
		[]
	);
	expect(toolFileOperations("read", { path: "src/a.ts" })).toEqual([]);
});

test("an empty path cannot enter a cumulative file set", () => {
	expect(
		toolFileOperations("read", {
			content: "",
			fileVersion: version("c"),
			path: "   ",
		})
	).toEqual([]);
});
