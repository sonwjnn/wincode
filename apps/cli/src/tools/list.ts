import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ListInput, ListOutput } from "@wincode/tools";
import { resolveWithinWorkspace, WORKSPACE } from "./resolve-within-workspace";

const toWorkspacePath = (absolutePath: string) =>
	path.relative(WORKSPACE, absolutePath).split(path.sep).join("/");

const collectEntries = async (
	absolutePath: string,
	remainingDepth: number,
	entries: ListOutput["entries"]
) => {
	const dirents = await readdir(absolutePath, { withFileTypes: true });

	for (const dirent of dirents.sort((left, right) =>
		left.name.localeCompare(right.name)
	)) {
		const childPath = path.join(absolutePath, dirent.name);

		if (dirent.isDirectory()) {
			entries.push({ path: toWorkspacePath(childPath), type: "directory" });

			if (remainingDepth > 1) {
				await collectEntries(childPath, remainingDepth - 1, entries);
			}

			continue;
		}

		if (dirent.isFile()) {
			entries.push({ path: toWorkspacePath(childPath), type: "file" });
		}
	}
};

export const runListTool = async (input: ListInput): Promise<ListOutput> => {
	const resolvedPath = resolveWithinWorkspace(input.path ?? ".");
	const entries: ListOutput["entries"] = [];

	await collectEntries(resolvedPath, input.depth ?? 2, entries);

	return { entries };
};
