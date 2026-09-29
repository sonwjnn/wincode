import * as path from "node:path";
import { isNull } from "@wincode/runtime-utils";
import { runBoundedGitCommand } from "./get-git-status";

/** Resolves the current git branch for `cwd`, or `null` when it isn't a git repo (or HEAD is detached). */
export const getGitBranch = async (cwd: string): Promise<string | null> => {
	const result = await runBoundedGitCommand(cwd, [
		"git",
		"branch",
		"--show-current",
	]);
	if (isNull(result) || result.exitCode !== 0 || result.truncated) {
		return null;
	}
	const branch = new TextDecoder("utf-8", { fatal: false })
		.decode(result.bytes)
		.trim();
	return branch || null;
};

/** HEAD lives in Git's per-worktree metadata directory, not necessarily in `cwd/.git`. */
export const getGitHeadPath = async (cwd: string): Promise<string | null> => {
	const result = await runBoundedGitCommand(cwd, [
		"git",
		"rev-parse",
		"--absolute-git-dir",
	]);
	if (isNull(result) || result.exitCode !== 0 || result.truncated) {
		return null;
	}
	const gitDir = new TextDecoder("utf-8", { fatal: false })
		.decode(result.bytes)
		.trim();
	return gitDir ? path.join(gitDir, "HEAD") : null;
};
