import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitBranch } from "@/shared/git/get-git-branch";
import { runGit } from "./support/git";

describe("getGitBranch", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wincode-git-branch-"));
	});

	afterEach(() => {
		rmSync(dir, { force: true, recursive: true });
	});

	test("returns null when cwd is not a git repo", async () => {
		expect(await getGitBranch(dir)).toBeNull();
	});

	test("returns the current branch name inside a git repo", async () => {
		await runGit(dir, ["init", "--initial-branch=main"]);
		expect(await getGitBranch(dir)).toBe("main");

		await runGit(dir, ["checkout", "-b", "feature/sidebar"]);
		expect(await getGitBranch(dir)).toBe("feature/sidebar");
	});
});
