import { type Dirent, existsSync, realpathSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_IGNORED_DIRECTORY_NAMES = new Set([
	".git",
	".next",
	".tanstack",
	".turbo",
	"build",
	"dist",
	"node_modules",
]);

export type WorkspaceTraversalEntry = {
	absolutePath: string;
	depth: number;
	relativePath: string;
	type: "directory" | "file";
};

export type WorkspaceTraversalOptions = {
	includeDirectories: boolean;
	includeFiles: boolean;
	maxDepth: number;
	maxEntries?: number;
	path?: string;
};

export type WorkspaceTraversalResult = {
	entries: WorkspaceTraversalEntry[];
	truncated: boolean;
};

export type WorkspacePolicy = {
	isIgnoredDirectory: (name: string) => boolean;
	root: string;
	relativePath: (absolutePath: string) => string;
	resolveExistingPath: (input: string) => Promise<string>;
	resolveNewPath: (input: string) => Promise<string>;
	traverse: (
		options: WorkspaceTraversalOptions
	) => Promise<WorkspaceTraversalResult>;
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

type TraversalContext = Required<
	Omit<WorkspaceTraversalOptions, "maxEntries" | "path">
> & {
	entries: WorkspaceTraversalEntry[];
	maxEntries?: number;
	policy: WorkspacePolicy;
	truncated: boolean;
};

export const isIgnoredWorkspaceDirectory = (name: string) =>
	WORKSPACE_IGNORED_DIRECTORY_NAMES.has(name);

const compareDirectoryEntries = (left: Dirent, right: Dirent) =>
	left.name.localeCompare(right.name);

const hasReachedEntryLimit = (context: TraversalContext) =>
	context.maxEntries !== undefined &&
	context.entries.length >= context.maxEntries;

const markTraversalTruncated = (context: TraversalContext) => {
	context.truncated = true;
};

const isBeyondMaxDepth = (depth: number, context: TraversalContext) => {
	if (depth <= context.maxDepth) {
		return false;
	}

	markTraversalTruncated(context);
	return true;
};

const pushTraversalEntry = (
	absolutePath: string,
	depth: number,
	type: WorkspaceTraversalEntry["type"],
	context: TraversalContext
) => {
	if (hasReachedEntryLimit(context)) {
		markTraversalTruncated(context);
		return false;
	}

	context.entries.push({
		absolutePath,
		depth,
		relativePath: context.policy.relativePath(absolutePath),
		type,
	});

	return true;
};

const collectWorkspaceDirectory = async (
	childPath: string,
	directoryName: string,
	childDepth: number,
	context: TraversalContext
) => {
	if (context.policy.isIgnoredDirectory(directoryName)) {
		return true;
	}

	const absolutePath = await context.policy.resolveExistingPath(childPath);

	if (
		context.includeDirectories &&
		!pushTraversalEntry(absolutePath, childDepth, "directory", context)
	) {
		return false;
	}

	if (childDepth >= context.maxDepth) {
		markTraversalTruncated(context);
		return true;
	}

	await collectWorkspaceEntries(absolutePath, childDepth, context);
	return true;
};

const collectWorkspaceFile = async (
	childPath: string,
	childDepth: number,
	context: TraversalContext
) => {
	if (!context.includeFiles) {
		return true;
	}

	const absolutePath = await context.policy.resolveExistingPath(childPath);

	return pushTraversalEntry(absolutePath, childDepth, "file", context);
};

const collectWorkspaceDirent = async (
	directoryPath: string,
	dirent: Dirent,
	depth: number,
	context: TraversalContext
) => {
	if (dirent.isSymbolicLink()) {
		return true;
	}

	if (hasReachedEntryLimit(context)) {
		markTraversalTruncated(context);
		return false;
	}

	const childDepth = depth + 1;
	const childPath = path.join(directoryPath, dirent.name);

	if (isBeyondMaxDepth(childDepth, context)) {
		return true;
	}

	if (dirent.isDirectory()) {
		return await collectWorkspaceDirectory(
			childPath,
			dirent.name,
			childDepth,
			context
		);
	}

	if (dirent.isFile()) {
		return await collectWorkspaceFile(childPath, childDepth, context);
	}

	return true;
};

const collectWorkspaceEntries = async (
	directoryPath: string,
	depth: number,
	context: TraversalContext
) => {
	if (hasReachedEntryLimit(context)) {
		markTraversalTruncated(context);
		return;
	}

	const dirents = await readdir(directoryPath, { withFileTypes: true });

	for (const dirent of dirents.toSorted(compareDirectoryEntries)) {
		if (
			!(await collectWorkspaceDirent(directoryPath, dirent, depth, context))
		) {
			return;
		}
	}
};

export const createWorkspaceSandbox = (
	root = process.cwd()
): WorkspacePolicy => {
	const workspaceRoot = realpathSync(root);
	const policy: WorkspacePolicy = {
		isIgnoredDirectory: isIgnoredWorkspaceDirectory,
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
		traverse: async ({
			includeDirectories,
			includeFiles,
			maxDepth,
			maxEntries,
			path: inputPath,
		}: WorkspaceTraversalOptions) => {
			const startPath = await policy.resolveExistingPath(inputPath ?? ".");
			const context: TraversalContext = {
				entries: [],
				includeDirectories,
				includeFiles,
				maxDepth,
				maxEntries,
				policy,
				truncated: false,
			};

			await collectWorkspaceEntries(startPath, 0, context);

			return { entries: context.entries, truncated: context.truncated };
		},
	};

	return policy;
};

export const defaultWorkspaceSandbox = createWorkspaceSandbox();

export const WORKSPACE = defaultWorkspaceSandbox.root;

export const traverseWorkspaceEntries = (
	options: WorkspaceTraversalOptions,
	policy = defaultWorkspaceSandbox
) => policy.traverse(options);

export function resolveWithinWorkspace(input: string) {
	const resolved = path.resolve(WORKSPACE, input);

	assertInsidePath(WORKSPACE, resolved, input);

	return resolved;
}
