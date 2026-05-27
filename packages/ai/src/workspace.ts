import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

export type WorkspaceSandbox = {
	root: string;
	relativePath: (absolutePath: string) => string;
	resolveExistingPath: (input: string) => Promise<string>;
	resolveNewPath: (input: string) => Promise<string>;
};

const isInsidePath = (root: string, target: string) =>
	target === root || target.startsWith(root + path.sep);

const assertInsidePath = (root: string, target: string, input: string) => {
	if (!isInsidePath(root, target)) {
		throw new Error(`Path escapes workspace: ${input}`);
	}
};

const findExistingParent = (targetPath: string) => {
	let parentPath = path.dirname(targetPath);

	while (!existsSync(parentPath)) {
		const nextParentPath = path.dirname(parentPath);

		if (nextParentPath === parentPath) {
			return parentPath;
		}

		parentPath = nextParentPath;
	}

	return parentPath;
};

export const createWorkspaceSandbox = (
	root = process.cwd()
): WorkspaceSandbox => {
	const workspaceRoot = realpathSync(root);

	return {
		root: workspaceRoot,
		relativePath: (absolutePath: string) =>
			path.relative(workspaceRoot, absolutePath).split(path.sep).join("/"),
		resolveExistingPath: async (input: string) => {
			const resolvedPath = path.resolve(workspaceRoot, input);

			assertInsidePath(workspaceRoot, resolvedPath, input);

			const realPath = await realpath(resolvedPath);
			assertInsidePath(workspaceRoot, realPath, input);

			return realPath;
		},
		resolveNewPath: async (input: string) => {
			const resolvedPath = path.resolve(workspaceRoot, input);

			assertInsidePath(workspaceRoot, resolvedPath, input);

			const existingParentPath = findExistingParent(resolvedPath);
			const realParentPath = await realpath(existingParentPath);

			assertInsidePath(workspaceRoot, realParentPath, input);

			return resolvedPath;
		},
	};
};

export const defaultWorkspaceSandbox = createWorkspaceSandbox();

export const WORKSPACE = defaultWorkspaceSandbox.root;

export function resolveWithinWorkspace(input: string) {
	const resolved = path.resolve(WORKSPACE, input);

	if (!(resolved.startsWith(WORKSPACE + path.sep) || resolved === WORKSPACE)) {
		throw new Error(`Path escapes workspace: ${input}`);
	}

	return resolved;
}
