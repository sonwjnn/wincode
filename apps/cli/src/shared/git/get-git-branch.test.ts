import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitBranch } from "./get-git-branch";

type BunSpawn = (
	command: string[],
	options: { cwd: string; stderr: "ignore"; stdout: "ignore" }
) => { exited: Promise<number> };

const bunGlobal = globalThis as typeof globalThis & {
	Bun: { spawn: BunSpawn };
};

const run = async (cwd: string, command: string[]) => {
	const process = bunGlobal.Bun.spawn(command, {
		cwd,
		stderr: "ignore",
		stdout: "ignore",
	});
	await process.exited;
};

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
		await run(dir, ["git", "init", "--initial-branch=main"]);
		expect(await getGitBranch(dir)).toBe("main");

		await run(dir, ["git", "checkout", "-b", "feature/sidebar"]);
		expect(await getGitBranch(dir)).toBe("feature/sidebar");
	});
});
