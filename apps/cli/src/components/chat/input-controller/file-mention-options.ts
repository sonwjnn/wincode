import { readdir } from "node:fs/promises";
import path from "node:path";

import type { FileMentionOption } from "./types";

const IGNORED_DIRECTORY_NAMES = new Set([
	".git",
	".next",
	".turbo",
	".tanstack",
	"build",
	"dist",
	"node_modules",
]);

const MAX_DEPTH = 5;
const MAX_FILE_MENTION_RESULTS = 100;

const isIgnoredDirectory = (name: string) => IGNORED_DIRECTORY_NAMES.has(name);

const formatOption = (
	relativePath: string,
	type: FileMentionOption["type"]
): FileMentionOption => ({
	label: type === "directory" ? `${relativePath}/` : relativePath,
	path: relativePath,
	type,
});

const walk = async (
	directoryPath: string,
	relativePrefix: string,
	depth: number,
	options: FileMentionOption[]
) => {
	if (depth > MAX_DEPTH) {
		return;
	}

	const dirents = await readdir(directoryPath, { withFileTypes: true });
	dirents.sort((left, right) => left.name.localeCompare(right.name));

	for (const dirent of dirents) {
		if (dirent.isSymbolicLink()) {
			continue;
		}

		if (dirent.isDirectory()) {
			if (isIgnoredDirectory(dirent.name)) {
				continue;
			}

			const relativePath = relativePrefix
				? `${relativePrefix}/${dirent.name}`
				: dirent.name;
			options.push(formatOption(relativePath, "directory"));
			await walk(
				path.join(directoryPath, dirent.name),
				relativePath,
				depth + 1,
				options
			);
			continue;
		}

		if (dirent.isFile()) {
			const relativePath = relativePrefix
				? `${relativePrefix}/${dirent.name}`
				: dirent.name;
			options.push(formatOption(relativePath, "file"));
		}
	}
};

export const getFileMentionOptions = async (): Promise<FileMentionOption[]> => {
	const options: FileMentionOption[] = [];
	await walk(process.cwd(), "", 0, options);
	return options;
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
