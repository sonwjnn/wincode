import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { GrepInput, GrepOutput } from "@wincode/tools";
import { resolveWithinWorkspace, WORKSPACE } from "./resolve-within-workspace";

const toWorkspacePath = (absolutePath: string) =>
	path.relative(WORKSPACE, absolutePath).split(path.sep).join("/");

const collectFiles = async (absolutePath: string): Promise<string[]> => {
	const fileStat = await stat(absolutePath);

	if (fileStat.isFile()) {
		return [absolutePath];
	}

	if (!fileStat.isDirectory()) {
		return [];
	}

	const files: string[] = [];
	const dirents = await readdir(absolutePath, { withFileTypes: true });

	for (const dirent of dirents.sort((left, right) =>
		left.name.localeCompare(right.name)
	)) {
		const childPath = path.join(absolutePath, dirent.name);

		if (dirent.isDirectory()) {
			files.push(...(await collectFiles(childPath)));
			continue;
		}

		if (dirent.isFile()) {
			files.push(childPath);
		}
	}

	return files;
};

export const runGrepTool = async (input: GrepInput): Promise<GrepOutput> => {
	const resolvedPath = resolveWithinWorkspace(input.path ?? ".");
	const regex = new RegExp(input.pattern, input.flags);
	const matches: GrepOutput["matches"] = [];

	for (const filePath of await collectFiles(resolvedPath)) {
		const content = await readFile(filePath, "utf8");
		const lines = content.split("\n");

		for (const [index, line] of lines.entries()) {
			regex.lastIndex = 0;

			if (regex.test(line)) {
				matches.push({
					line,
					lineNumber: index + 1,
					path: toWorkspacePath(filePath),
				});
			}
		}
	}

	return { matches };
};
