import { readdir } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceSandbox } from "../workspace";

const IGNORED_DIRECTORY_NAMES = new Set([
	".git",
	".next",
	".turbo",
	"build",
	"dist",
	"node_modules",
]);

export type TraversalEntry = {
	absolutePath: string;
	depth: number;
	relativePath: string;
	type: "directory" | "file";
};

type TraverseWorkspaceOptions = {
	includeDirectories: boolean;
	includeFiles: boolean;
	maxDepth: number;
	path?: string;
};

type TraversalContext = Required<Omit<TraverseWorkspaceOptions, "path">> & {
	entries: TraversalEntry[];
};

const shouldIgnoreDirectory = (name: string) =>
	IGNORED_DIRECTORY_NAMES.has(name);

const createEntry = (
	absolutePath: string,
	depth: number,
	type: TraversalEntry["type"]
): TraversalEntry => ({
	absolutePath,
	depth,
	relativePath: defaultWorkspaceSandbox.relativePath(absolutePath),
	type,
});

const collectEntries = async (
	directoryPath: string,
	depth: number,
	context: TraversalContext
) => {
	const dirents = await readdir(directoryPath, { withFileTypes: true });

	for (const dirent of dirents.sort((left, right) =>
		left.name.localeCompare(right.name)
	)) {
		if (dirent.isSymbolicLink()) {
			continue;
		}

		const childPath = path.join(directoryPath, dirent.name);

		if (dirent.isDirectory()) {
			await collectDirectory(childPath, dirent.name, depth, context);
			continue;
		}

		if (dirent.isFile() && context.includeFiles) {
			const absolutePath =
				await defaultWorkspaceSandbox.resolveExistingPath(childPath);

			context.entries.push(createEntry(absolutePath, depth, "file"));
		}
	}
};

const collectDirectory = async (
	childPath: string,
	directoryName: string,
	depth: number,
	context: TraversalContext
) => {
	if (shouldIgnoreDirectory(directoryName)) {
		return;
	}

	const childDepth = depth + 1;

	if (childDepth > context.maxDepth) {
		return;
	}

	const absolutePath =
		await defaultWorkspaceSandbox.resolveExistingPath(childPath);

	if (context.includeDirectories) {
		context.entries.push(createEntry(absolutePath, childDepth, "directory"));
	}

	if (childDepth < context.maxDepth) {
		await collectEntries(absolutePath, childDepth, context);
	}
};

export const traverseWorkspace = async ({
	includeDirectories,
	includeFiles,
	maxDepth,
	path: inputPath,
}: TraverseWorkspaceOptions): Promise<TraversalEntry[]> => {
	const startPath = await defaultWorkspaceSandbox.resolveExistingPath(
		inputPath ?? "."
	);
	const context: TraversalContext = {
		entries: [],
		includeDirectories,
		includeFiles,
		maxDepth,
	};

	await collectEntries(startPath, 0, context);

	return context.entries;
};
