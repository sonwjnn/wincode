import { traverseWorkspaceEntries } from "@wincode/ai/workspace";

import type { FileMentionOption } from "../types";

const MAX_DEPTH = 5;
const MAX_FILE_MENTION_RESULTS = 100;

const formatOption = (
	relativePath: string,
	type: FileMentionOption["type"]
): FileMentionOption => ({
	label: type === "directory" ? `${relativePath}/` : relativePath,
	path: relativePath,
	type,
});

export const getFileMentionOptions = async (): Promise<FileMentionOption[]> => {
	const result = await traverseWorkspaceEntries({
		includeDirectories: true,
		includeFiles: true,
		maxDepth: MAX_DEPTH + 1,
	});

	return result.entries.map((entry) =>
		formatOption(entry.relativePath, entry.type)
	);
};

export const filterFileMentionOptions = (
	options: FileMentionOption[],
	query: string
) => {
	const normalizedQuery = query.toLowerCase();
	const matches: FileMentionOption[] = [];

	for (const option of options) {
		if (
			normalizedQuery.length === 0 ||
			option.path.toLowerCase().includes(normalizedQuery)
		) {
			matches.push(option);
		}

		if (matches.length === MAX_FILE_MENTION_RESULTS) {
			break;
		}
	}

	return matches;
};
