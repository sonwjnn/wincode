import { relative, resolve } from "node:path";
import type { AgentRole } from "@wincode/agent-core";
import { getGitBranch } from "@/shared/git/get-git-branch";
import {
	formatGitStatusSummary,
	type GitStatusSummary,
	getGitRepositoryRoot,
	getGitStatusSummary,
} from "@/shared/git/get-git-status";

export type PromptEnvironmentGit = {
	readonly getBranch: (cwd: string) => Promise<string | null>;
	readonly getRepositoryRoot: (cwd: string) => Promise<string | null>;
	readonly getStatus: (cwd: string) => Promise<string | GitStatusSummary>;
};

export type PromptStableEnvironment = {
	readonly agentRole: AgentRole;
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
	readonly role?: AgentRole;
	readonly workspace: string;
};
const defaultGit: PromptEnvironmentGit = {
	getBranch: getGitBranch,
	getRepositoryRoot: getGitRepositoryRoot,
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
	const workspace = resolve(input.workspace);
	const cwd = resolve(input.cwd ?? workspace);
	const git = input.git ?? defaultGit;
	const projectRoot =
		input.projectRoot === undefined
			? await git.getRepositoryRoot(workspace)
			: input.projectRoot;
	const [branch, status] = await Promise.all([
		git.getBranch(workspace),
		git.getStatus(workspace),
	]);
	return {
		stable: {
			...stableRepository(workspace, projectRoot),
			agentRole: input.role ?? "primary",
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
