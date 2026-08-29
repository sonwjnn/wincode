import { fitsSerializedBytes } from "../output-bounds";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
} from "../resource-limits";
import { traverseWorkspace } from "../traversal";
import type { ListInput, ListOutput } from "./schema";

export type ListToolOptions = ResourceLimitOptions;

export const runListTool = async (
	input: ListInput,
	options: ListToolOptions = {}
): Promise<ListOutput> => {
	const limits = options.resourceLimits ?? getToolResourceLimits();
	const requestedDepth = input.depth ?? 2;
	const maxDepth = Math.min(requestedDepth, limits.list.maxDepth);
	const traversal = await traverseWorkspace({
		includeDirectories: true,
		includeFiles: true,
		maxDepth,
		maxEntries: limits.list.maxEntries,
		path: input.path,
	});

	const outputEntries = traversal.entries.map((entry) => ({
		path: entry.relativePath,
		type: entry.type,
	}));
	const result: ListOutput = { entries: [] };
	if (requestedDepth > maxDepth || traversal.truncated) {
		result.truncated = true;
	}
	for (const entry of outputEntries) {
		const candidate = {
			entries: result.entries.concat(entry),
			...(result.truncated === true ? { truncated: true } : {}),
		};
		if (!fitsSerializedBytes(candidate, limits.list.maxOutputBytes)) {
			return { ...result, truncated: true };
		}
		result.entries.push(entry);
	}
	return result;
};
