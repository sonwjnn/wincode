import * as path from "node:path";
import { isNull } from "@wincode/utils";
import { runBoundedGitCommand } from "./get-git-status";

const SCP_REMOTE_REGEX = /^(?:[^@]+@)?([^:/]+):(.+)$/u;
const GIT_SUFFIX_REGEX = /\.git$/iu;
const TRAILING_SLASHES_REGEX = /\/+$/u;

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

/** Resolves the origin repository to a browser-friendly URL, or `null` when unavailable. */
export const getGitRepositoryWebUrl = async (
	cwd: string
): Promise<string | null> => {
	const result = await runBoundedGitCommand(cwd, [
		"git",
		"remote",
		"get-url",
		"origin",
	]);
	if (isNull(result) || result.exitCode !== 0 || result.truncated) {
		return null;
	}

	const remote = new TextDecoder("utf-8", { fatal: false })
		.decode(result.bytes)
		.trim();
	const scpRemote = remote.includes("://")
		? null
		: SCP_REMOTE_REGEX.exec(remote);
	let repositoryUrl: URL;
	try {
		repositoryUrl = new URL(
			scpRemote ? `https://${scpRemote[1]}/${scpRemote[2]}` : remote
		);
	} catch {
		return null;
	}
	if (repositoryUrl.protocol === "ssh:" || repositoryUrl.protocol === "git:") {
		repositoryUrl.protocol = "https:";
	} else if (
		repositoryUrl.protocol !== "http:" &&
		repositoryUrl.protocol !== "https:"
	) {
		return null;
	}

	repositoryUrl.username = "";
	repositoryUrl.password = "";
	repositoryUrl.search = "";
	repositoryUrl.hash = "";
	repositoryUrl.pathname = repositoryUrl.pathname
		.replace(GIT_SUFFIX_REGEX, "")
		.replace(TRAILING_SLASHES_REGEX, "");
	return `${repositoryUrl.origin}${repositoryUrl.pathname}`;
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
