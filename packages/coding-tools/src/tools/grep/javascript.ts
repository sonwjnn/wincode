import { readFile, stat } from "node:fs/promises";
import { truncateUtf8 } from "../output-bounds";
import { getToolResourceLimits } from "../resource-limits";
import { traverseWorkspace } from "../traversal";
import type { GrepSearch, GrepSearchInput, GrepSearchResult } from "./backend";

export const validateGrepPattern = (pattern: string): void => {
	try {
		new RegExp(pattern);
	} catch {
		throw new Error("Invalid grep pattern.");
	}
};

export const runJavascriptGrep: GrepSearch = async (
	input: GrepSearchInput
): Promise<GrepSearchResult> => {
	validateGrepPattern(input.pattern);
	const regex = new RegExp(input.pattern);
	const matches: GrepSearchResult["matches"] = [];
	const maxDurationMs =
		input.maxDurationMs ?? getToolResourceLimits().grep.maxDurationMs;
	const deadline = Date.now() + maxDurationMs;
	const traversal = await traverseWorkspace({
		includeDirectories: false,
		includeFiles: true,
		maxDepth: input.maxDepth,
		maxEntries: input.maxFiles,
		path: input.path,
	});
	if (Date.now() >= deadline) {
		return { matches, truncated: true };
	}

	for (const entry of traversal.entries) {
		if (Date.now() >= deadline) {
			return { matches, truncated: true };
		}
		const fileStat = await stat(entry.absolutePath);

		if (fileStat.size > input.maxFileBytes) {
			continue;
		}

		const content = await readFile(entry.absolutePath, "utf8");
		const lines = content.split("\n");

		for (const [index, line] of lines.entries()) {
			if (Date.now() >= deadline) {
				return { matches, truncated: true };
			}
			if (!regex.test(line)) {
				continue;
			}

			matches.push({
				line: truncateUtf8(line, input.maxLineBytes),
				lineNumber: index + 1,
				path: entry.relativePath,
			});

			if (matches.length >= input.maxMatches) {
				return { matches, truncated: true };
			}
		}
	}

	return traversal.truncated ? { matches, truncated: true } : { matches };
};
