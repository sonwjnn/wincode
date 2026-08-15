import { describe, expect, test } from "bun:test";
import path from "node:path";
import { MAX_WORKSPACE_WALK_DEPTH, resolveWorkspaceRoot } from "./workspace";

const gitExistsAt = (repo: string) => (candidate: string) =>
	candidate === path.join(repo, ".git");

describe("resolveWorkspaceRoot", () => {
	test("walks up to the nearest .git ancestor", () => {
		const repo = "/repo";
		const start = path.join(repo, "apps", "cli");
		expect(resolveWorkspaceRoot(start, { exists: gitExistsAt(repo) })).toBe(
			repo
		);
	});

	test("a directory containing .git is its own root", () => {
		const repo = "/repo";
		expect(resolveWorkspaceRoot(repo, { exists: gitExistsAt(repo) })).toBe(
			repo
		);
	});

	test("a child directory is resolved to the repository root", () => {
		const repo = "/repo";
		expect(
			resolveWorkspaceRoot(path.join(repo, "packages", "ai"), {
				exists: gitExistsAt(repo),
			})
		).toBe(repo);
	});

	test("stops at the filesystem root without a .git", () => {
		const start = "/tmp/plain-folder";
		expect(resolveWorkspaceRoot(start, { exists: () => false })).toBe(start);
	});

	test("gives up after the bounded walk and keeps the start", () => {
		const start = "/a/b/c/d/e";
		expect(
			resolveWorkspaceRoot(start, {
				exists: () => false,
				maxDepth: 2,
			})
		).toBe(path.resolve(start));
	});

	test("the default walk depth is bounded", () => {
		expect(MAX_WORKSPACE_WALK_DEPTH).toBeGreaterThan(0);
		expect(MAX_WORKSPACE_WALK_DEPTH).toBeLessThanOrEqual(64);
	});

	test("a git root under the default walk depth is found", () => {
		const repo = "/repo";
		const start = path.join(repo, "a", "b", "c", "d");
		expect(
			resolveWorkspaceRoot(start, {
				exists: gitExistsAt(repo),
				maxDepth: MAX_WORKSPACE_WALK_DEPTH,
			})
		).toBe(repo);
	});
});
