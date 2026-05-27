import { readFile } from "node:fs/promises";
import { defaultWorkspaceSandbox } from "../../workspace";
import type { ReadInput, ReadOutput } from "./schema";

export const runReadTool = async (input: ReadInput): Promise<ReadOutput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
		input.path
	);
	const content = await readFile(resolvedPath, "utf8");

	return { content, path: input.path };
};
