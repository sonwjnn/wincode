import { fitsSerializedBytes } from "../output-bounds";
import { traverseWorkspace } from "../traversal";
import type { ListInput, ListOutput } from "./schema";

const LIST_OUTPUT_MAX_BYTES = 4000;

export const runListTool = async (input: ListInput): Promise<ListOutput> => {
	const entries = await traverseWorkspace({
		includeDirectories: true,
		includeFiles: true,
		maxDepth: input.depth ?? 2,
		path: input.path,
	});

	const outputEntries = entries.map((entry) => ({
		path: entry.relativePath,
		type: entry.type,
	}));
	const result: ListOutput = { entries: [] };
	for (const entry of outputEntries) {
		const candidate = { entries: [...result.entries, entry] };
		if (!fitsSerializedBytes(candidate, LIST_OUTPUT_MAX_BYTES)) {
			return { ...result, truncated: true };
		}
		result.entries.push(entry);
	}
	return result;
};
