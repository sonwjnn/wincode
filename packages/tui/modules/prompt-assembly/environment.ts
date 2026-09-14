import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getGitBranch } from "@/shared/git/get-git-branch";
import {
	formatGitStatusSummary,
	type GitStatusSummary,
	getGitRepositoryRoot,
	getGitStatusSummary,
} from "@/shared/git/get-git-status";
import { canonicalPath } from "@/shared/paths/project-roots";

export type PromptEnvironmentGit = {
	readonly getBranch: (cwd: string) => Promise<string | null>;
	readonly getRepositoryRoot: (cwd: string) => Promise<string | null>;
	readonly getStatus: (cwd: string) => Promise<string | GitStatusSummary>;
};

export type PromptStableEnvironment = {
	readonly cwd: string;
	readonly modelId: string;
	readonly platform: string;
	readonly providerId: string;
	readonly repository: "git" | "none";
	readonly worktree: string | null;
	readonly workspace: string;
};

export type PromptVolatileEnvironment = {
	readonly branch: string | null;
	readonly status: string;
};

export type PromptEnvironmentSnapshot = {
	readonly stable: PromptStableEnvironment;
	readonly volatile: PromptVolatileEnvironment;
};

export type PromptEnvironmentSnapshotInput = {
	readonly cwd?: string;
	readonly git?: PromptEnvironmentGit;
	readonly model: {
		readonly modelId: string;
		readonly providerId: string;
	};
	readonly platform?: string;
	readonly projectRoot?: string | null;
	readonly workspace: string;
};
const hasGitRootMarker = (workspace: string): boolean =>
	existsSync(join(resolve(workspace), ".git"));

const defaultGit: PromptEnvironmentGit = {
	getBranch: getGitBranch,
	getRepositoryRoot: async (cwd) =>
		hasGitRootMarker(cwd) ? getGitRepositoryRoot(cwd) : null,
	getStatus: async (cwd) =>
		formatGitStatusSummary(await getGitStatusSummary(cwd)),
};

const relativePath = (workspace: string, path: string): string => {
	const value = relative(workspace, path).replaceAll("\\", "/");
	return value.length > 0 ? value : ".";
};

const stableRepository = (
	workspace: string,
	projectRoot: string | null
): Pick<PromptStableEnvironment, "repository" | "worktree"> => {
	if (projectRoot === null) {
		return { repository: "none", worktree: null };
	}
	return {
		repository: "git",
		worktree: relativePath(resolve(projectRoot), workspace),
	};
};

const statusText = (status: string | GitStatusSummary): string =>
	typeof status === "string" ? status : formatGitStatusSummary(status);

/**
 * Captures the stable and volatile context once for a Model Step. It reads no
 * environment variables and deliberately reduces Git state to bounded counts.
 */
export const createEnvironmentSnapshot = async (
	input: PromptEnvironmentSnapshotInput
): Promise<PromptEnvironmentSnapshot> => {
	const workspace = await canonicalPath(input.workspace);
	const cwd = await canonicalPath(input.cwd ?? workspace);
	const git = input.git ?? defaultGit;
	let projectRoot: string | null;
	if (input.projectRoot === undefined) {
		const discoveredProjectRoot = await git.getRepositoryRoot(workspace);
		projectRoot =
			discoveredProjectRoot === null
				? null
				: await canonicalPath(discoveredProjectRoot);
	} else if (input.projectRoot === null) {
		projectRoot = null;
	} else {
		projectRoot = await canonicalPath(input.projectRoot);
	}
	const [branch, status] =
		projectRoot === null
			? [null, "unavailable" as const]
			: await Promise.all([git.getBranch(workspace), git.getStatus(workspace)]);
	return {
		stable: {
			...stableRepository(workspace, projectRoot),
			cwd: relativePath(workspace, cwd),
			modelId: input.model.modelId,
			platform: input.platform ?? process.platform,
			providerId: input.model.providerId,
			workspace,
		},
		volatile: {
			branch,
			status: statusText(status),
		},
	};
};
