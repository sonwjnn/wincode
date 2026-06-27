import {
	defaultWorkspaceSandbox,
	type WorkspaceTraversalEntry,
} from "../workspace";

export type TraversalEntry = WorkspaceTraversalEntry;

type TraverseWorkspaceOptions = {
	includeDirectories: boolean;
	includeFiles: boolean;
	maxDepth: number;
	path?: string;
};

export const traverseWorkspace = async ({
	includeDirectories,
	includeFiles,
	maxDepth,
	path: inputPath,
}: TraverseWorkspaceOptions): Promise<TraversalEntry[]> => {
	const result = await defaultWorkspaceSandbox.traverse({
		includeDirectories,
		includeFiles,
		maxDepth,
		path: inputPath,
	});

	return result.entries;
};
