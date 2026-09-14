import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const canonicalPath = async (path: string): Promise<string> => {
	const resolvedPath = resolve(path);
	try {
		return await realpath(resolvedPath);
	} catch {
		return resolvedPath;
	}
};

export const getProjectRoots = (workspace: string): string[] => {
	const start = resolve(workspace);
	const ancestors: string[] = [];
	let current = start;
	while (true) {
		ancestors.push(current);
		if (existsSync(join(current, ".git"))) {
			return ancestors.reverse();
		}
		const parent = dirname(current);
		if (parent === current) {
			return [start];
		}
		current = parent;
	}
};

/**
 * Returns every directory from the active workspace through the current
 * working directory, without ever walking above the workspace boundary.
 */
export const getProjectRootsWithinWorkspace = (
	workspace: string,
	cwd = workspace
): string[] => {
	const resolvedWorkspace = resolve(workspace);
	const resolvedCwd = resolve(cwd);
	const workspacePrefix = `${resolvedWorkspace}${sep}`;
	const cwdIsWithinWorkspace =
		resolvedWorkspace === sep ||
		resolvedCwd === resolvedWorkspace ||
		resolvedCwd.startsWith(workspacePrefix);
	let current = cwdIsWithinWorkspace ? resolvedCwd : resolvedWorkspace;
	const roots: string[] = [];
	while (true) {
		roots.push(current);
		if (current === resolvedWorkspace) {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			return [resolvedWorkspace];
		}
		current = parent;
	}
	return roots.reverse();
};
