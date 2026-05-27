import { readFile, stat } from "node:fs/promises";
import { traverseWorkspace } from "../traversal";
import type { GrepInput, GrepOutput } from "./schema";

const GREP_MAX_DEPTH = 5;
const GREP_MAX_FILE_BYTES = 1_000_000;
const GREP_MAX_FILES = 1000;
const GREP_MAX_MATCHES = 1000;

const createRegex = (input: GrepInput) => {
	try {
		return new RegExp(input.pattern, input.flags);
	} catch {
		throw new Error("Invalid grep pattern.");
	}
};

export const runGrepTool = async (input: GrepInput): Promise<GrepOutput> => {
	const regex = createRegex(input);
	const matches: GrepOutput["matches"] = [];
	const entries = await traverseWorkspace({
		includeDirectories: false,
		includeFiles: true,
		maxDepth: GREP_MAX_DEPTH,
		path: input.path,
	});

	for (const entry of entries.slice(0, GREP_MAX_FILES)) {
		const fileStat = await stat(entry.absolutePath);

		if (fileStat.size > GREP_MAX_FILE_BYTES) {
			continue;
		}

		const content = await readFile(entry.absolutePath, "utf8");
		const lines = content.split("\n");

		for (const [index, line] of lines.entries()) {
			regex.lastIndex = 0;

			if (regex.test(line)) {
				matches.push({
					line,
					lineNumber: index + 1,
					path: entry.relativePath,
				});

				if (matches.length >= GREP_MAX_MATCHES) {
					return { matches };
				}
			}
		}
	}

	return { matches };
};
