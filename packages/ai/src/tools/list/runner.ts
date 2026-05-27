import { traverseWorkspace } from "../traversal";
import type { ListInput, ListOutput } from "./schema";

export const runListTool = async (input: ListInput): Promise<ListOutput> => {
	const entries = await traverseWorkspace({
		includeDirectories: true,
		includeFiles: true,
		maxDepth: input.depth ?? 2,
		path: input.path,
	});

	return {
		entries: entries.map((entry) => ({
			path: entry.relativePath,
			type: entry.type,
		})),
	};
};
