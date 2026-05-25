import { readFile } from "node:fs/promises";
import type { ReadInput, ReadOutput } from "@wincode/tools";
import { resolveWithinWorkspace } from "./resolve-within-workspace";

export const runReadTool = async (input: ReadInput): Promise<ReadOutput> => {
	const resolvedPath = resolveWithinWorkspace(input.path);
	const content = await readFile(resolvedPath, "utf8");

	return { content, path: input.path };
};
