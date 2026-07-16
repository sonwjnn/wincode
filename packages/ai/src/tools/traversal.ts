import {
	defaultWorkspaceSandbox,
	type WorkspaceTraversalEntry,
} from "../workspace";

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
}: TraverseWorkspaceOptions): Promise<WorkspaceTraversalEntry[]> => {
	const result = await defaultWorkspaceSandbox.traverse({
		includeDirectories,
		includeFiles,
		maxDepth,
		path: inputPath,
	});

	return result.entries;
};
