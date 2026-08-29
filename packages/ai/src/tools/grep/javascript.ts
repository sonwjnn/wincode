import { readFile, stat } from "node:fs/promises";
import { truncateUtf8 } from "../output-bounds";
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
	const entries = await traverseWorkspace({
		includeDirectories: false,
		includeFiles: true,
		maxDepth: input.maxDepth,
		path: input.path,
	});

	for (const entry of entries.slice(0, input.maxFiles)) {
		const fileStat = await stat(entry.absolutePath);

		if (fileStat.size > input.maxFileBytes) {
			continue;
		}

		const content = await readFile(entry.absolutePath, "utf8");
		const lines = content.split("\n");

		for (const [index, line] of lines.entries()) {
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

	return { matches };
};
