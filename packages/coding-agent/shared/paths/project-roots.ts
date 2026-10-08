import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as path from "node:path";

export const canonicalPath = async (pathValue: string): Promise<string> => {
	const resolvedPath = path.resolve(pathValue);
	try {
		return await realpath(resolvedPath);
	} catch {
		return resolvedPath;
	}
};

/** Synchronous counterpart for discovery APIs that must resolve roots inline. */
export const canonicalPathSync = (pathValue: string): string => {
	const resolvedPath = path.resolve(pathValue);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
};

export const getProjectRoots = (workspace: string): string[] => {
	const start = path.resolve(workspace);
	const ancestors: string[] = [];
	let current = start;
	while (true) {
		ancestors.push(current);
		if (fs.existsSync(path.join(current, ".git"))) {
			return ancestors.reverse();
		}
		const parent = path.dirname(current);
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
	const resolvedWorkspace = path.resolve(workspace);
	const resolvedCwd = path.resolve(cwd);
	const workspacePrefix = `${resolvedWorkspace}${path.sep}`;
	const cwdIsWithinWorkspace =
		resolvedWorkspace === path.sep ||
		resolvedCwd === resolvedWorkspace ||
		resolvedCwd.startsWith(workspacePrefix);
	let current = cwdIsWithinWorkspace ? resolvedCwd : resolvedWorkspace;
	const roots: string[] = [];
	while (true) {
		roots.push(current);
		if (current === resolvedWorkspace) {
			break;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return [resolvedWorkspace];
		}
		current = parent;
	}
	return roots.reverse();
};
