import { defaultWorkspaceSandbox } from "../workspace";

type TraverseWorkspaceOptions = {
	includeDirectories: boolean;
	includeFiles: boolean;
	maxDepth: number;
	maxEntries?: number;
	path?: string;
};

export const traverseWorkspace = async ({
	includeDirectories,
	includeFiles,
	maxDepth,
	maxEntries,
	path: inputPath,
}: TraverseWorkspaceOptions) =>
	defaultWorkspaceSandbox.traverse({
		includeDirectories,
		includeFiles,
		maxDepth,
		maxEntries,
		path: inputPath,
	});
