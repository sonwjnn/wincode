import { type Dirent, existsSync, realpathSync } from "node:fs";
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

export const WORKSPACE_IGNORED_DIRECTORY_NAMES = new Set([
	".git",
	".next",
	".tanstack",
	".turbo",
	"build",
	"dist",
	"node_modules",
]);

/**
 * The maximum number of parent directories the workspace-root walk-up visits
 * before giving up, so a hostile or enormous filesystem cannot stall startup.
 */
export const MAX_WORKSPACE_WALK_DEPTH = 16;

export type ResolveWorkspaceRootOptions = {
	/** Injectable existence probe so the walk-up stays pure and unit-testable. */
	exists?: (candidatePath: string) => boolean;
	maxDepth?: number;
};

/**
 * Resolves the workspace root by walking up from `start` to the nearest
 * ancestor containing a `.git` directory, bounded by {@link MAX_WORKSPACE_WALK_DEPTH}.
 * When no ancestor is a git root, the start path itself is the workspace, so
 * launching the CLI from a repository subdirectory still places the whole
 * repository inside the sandbox.
 */
export const resolveWorkspaceRoot = (
	start: string,
	options: ResolveWorkspaceRootOptions = {}
): string => {
	const exists = options.exists ?? existsSync;
	const maxDepth = options.maxDepth ?? MAX_WORKSPACE_WALK_DEPTH;
	const resolvedStart = path.resolve(start);
	let current = resolvedStart;
	for (let depth = 0; depth < maxDepth; depth += 1) {
		if (exists(path.join(current, ".git"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return resolvedStart;
};

export type WorkspaceTraversalEntry = {
	absolutePath: string;
	depth: number;
	relativePath: string;
	symlinkTarget?: string;
	type: "directory" | "file";
};

export type WorkspaceTraversalOptions = {
	includeDirectories: boolean;
	includeFiles: boolean;
	includeSymlinks?: boolean;
	maxDepth: number;
	maxEntries?: number;
	path?: string;
	/** Hides dotfiles and dot-directories from discovery. */
	hideDotfiles?: boolean;
	/** Applies the workspace-root and nested `.gitignore` rules. */
	respectGitignore?: boolean;
	/** Allows an explicitly selected ignored root to be inspected. */
	allowIgnoredRoot?: boolean;
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

type IgnoreRuleSet = {
	directoryPath: string;
	matcher: Ignore;
};

type TraversalContext = Required<
	Omit<WorkspaceTraversalOptions, "maxEntries" | "path">
> & {
	entries: WorkspaceTraversalEntry[];
	ignoreRules: IgnoreRuleSet[];
	loadIgnoreRules: (directoryPath: string) => Promise<IgnoreRuleSet | null>;
	maxEntries?: number;
	policy: WorkspacePolicy;
	truncated: boolean;
};

export const isIgnoredWorkspaceDirectory = (name: string) =>
	WORKSPACE_IGNORED_DIRECTORY_NAMES.has(name);

const compareDirectoryEntries = (left: Dirent, right: Dirent) =>
	left.name.localeCompare(right.name);

const isMissingIgnoreFile = (error: unknown): error is NodeJS.ErrnoException =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "ENOENT";

const getIgnoreRelativePath = (
	ruleSet: IgnoreRuleSet,
	targetPath: string,
	type: WorkspaceTraversalEntry["type"]
) => {
	const relativePath = path
		.relative(ruleSet.directoryPath, targetPath)
		.split(path.sep)
		.join("/");

	return type === "directory" ? `${relativePath}/` : relativePath;
};

const isGitignoredPath = (
	targetPath: string,
	type: WorkspaceTraversalEntry["type"],
	context: TraversalContext
) => {
	if (!context.respectGitignore) {
		return false;
	}

	let ignored = false;
	for (const ruleSet of context.ignoreRules) {
		const result = ruleSet.matcher.test(
			getIgnoreRelativePath(ruleSet, targetPath, type)
		);
		if (result.ignored) {
			ignored = true;
		} else if (result.unignored) {
			ignored = false;
		}
	}

	return ignored;
};
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
	context: TraversalContext,
	symlinkTarget?: string
) => {
	if (hasReachedEntryLimit(context)) {
		markTraversalTruncated(context);
		return false;
	}

	context.entries.push({
		absolutePath,
		depth,
		relativePath: context.policy.relativePath(absolutePath),
		...(symlinkTarget === undefined ? {} : { symlinkTarget }),
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
	if (
		context.policy.isIgnoredDirectory(directoryName) ||
		isGitignoredPath(childPath, "directory", context)
	) {
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
	if (!context.includeFiles || isGitignoredPath(childPath, "file", context)) {
		return true;
	}

	const absolutePath = await context.policy.resolveExistingPath(childPath);

	return pushTraversalEntry(absolutePath, childDepth, "file", context);
};

const collectWorkspaceSymlink = async (
	childPath: string,
	childName: string,
	childDepth: number,
	context: TraversalContext
) => {
	if (
		!context.includeSymlinks ||
		isIgnoredWorkspaceDirectory(childName) ||
		isGitignoredPath(childPath, "file", context)
	) {
		return true;
	}

	const symlinkTarget = await readlink(childPath);
	return pushTraversalEntry(
		childPath,
		childDepth,
		"file",
		context,
		symlinkTarget
	);
};

const collectWorkspaceDirent = async (
	directoryPath: string,
	dirent: Dirent,
	depth: number,
	context: TraversalContext
) => {
	if (context.hideDotfiles && dirent.name.startsWith(".")) {
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

	if (dirent.isSymbolicLink()) {
		return await collectWorkspaceSymlink(
			childPath,
			dirent.name,
			childDepth,
			context
		);
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

	const localIgnoreRules = context.respectGitignore
		? await context.loadIgnoreRules(directoryPath)
		: null;
	if (localIgnoreRules) {
		context.ignoreRules.push(localIgnoreRules);
	}

	try {
		const dirents = await readdir(directoryPath, { withFileTypes: true });

		for (const dirent of dirents.toSorted(compareDirectoryEntries)) {
			if (
				!(await collectWorkspaceDirent(directoryPath, dirent, depth, context))
			) {
				return;
			}
		}
	} finally {
		if (localIgnoreRules) {
			context.ignoreRules.pop();
		}
	}
};

export const createWorkspaceSandbox = (
	root = resolveWorkspaceRoot(process.cwd())
): WorkspacePolicy => {
	const workspaceRoot = realpathSync(root);
	const ignoreRuleCache = new Map<string, Promise<IgnoreRuleSet | null>>();
	const workspaceRootHasGitMetadata = path
		.resolve(workspaceRoot)
		.split(path.sep)
		.includes(".git");
	const loadIgnoreRules = (
		directoryPath: string
	): Promise<IgnoreRuleSet | null> => {
		const cachedRules = ignoreRuleCache.get(directoryPath);
		if (cachedRules) {
			return cachedRules;
		}

		const rulesPromise = readFile(
			path.join(directoryPath, ".gitignore"),
			"utf8"
		)
			.then((contents) => ({
				directoryPath,
				matcher: ignore().add(contents),
			}))
			.catch((error: unknown) => {
				if (isMissingIgnoreFile(error)) {
					return null;
				}

				throw error;
			});
		const cachedPromise = rulesPromise.catch((error: unknown) => {
			ignoreRuleCache.delete(directoryPath);
			throw error;
		});
		ignoreRuleCache.set(directoryPath, cachedPromise);
		return cachedPromise;
	};
	const loadAncestorIgnoreRules = async (
		startPath: string
	): Promise<IgnoreRuleSet[]> => {
		const relativePath = path.relative(workspaceRoot, startPath);
		const segments = relativePath ? relativePath.split(path.sep) : [];
		const inheritedRules: IgnoreRuleSet[] = [];
		let directoryPath = workspaceRoot;

		for (const segment of segments) {
			const ruleSet = await loadIgnoreRules(directoryPath);
			if (ruleSet) {
				inheritedRules.push(ruleSet);
			}
			directoryPath = path.join(directoryPath, segment);
		}

		return inheritedRules;
	};
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
			includeSymlinks = false,
			maxDepth,
			maxEntries,
			path: inputPath,
			hideDotfiles = false,
			respectGitignore = false,
			allowIgnoredRoot = false,
		}: WorkspaceTraversalOptions) => {
			const startPath = await policy.resolveExistingPath(inputPath ?? ".");
			const context: TraversalContext = {
				entries: [],
				ignoreRules: respectGitignore
					? await loadAncestorIgnoreRules(startPath)
					: [],
				includeDirectories,
				includeFiles,
				includeSymlinks,
				loadIgnoreRules,
				maxDepth,
				maxEntries,
				policy,
				respectGitignore,
				hideDotfiles,
				allowIgnoredRoot,
				truncated: false,
			};

			// Any traversal rooted inside `.git` is hard-pruned, including
			// explicit reads such as `.git/objects`.
			const relativeStartPath = path.relative(workspaceRoot, startPath);
			const isGitMetadataPath =
				workspaceRootHasGitMetadata ||
				path.basename(startPath) === ".git" ||
				relativeStartPath.split(path.sep).includes(".git");
			const ignoredRoot = isGitignoredPath(startPath, "directory", context);
			if (isGitMetadataPath || (!allowIgnoredRoot && ignoredRoot)) {
				return { entries: context.entries, truncated: context.truncated };
			}

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
