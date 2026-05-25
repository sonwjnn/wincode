import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WriteInput, WriteOutput } from "@wincode/tools";
import { resolveWithinWorkspace } from "./resolve-within-workspace";

export const runWriteTool = async (input: WriteInput): Promise<WriteOutput> => {
	const resolvedPath = resolveWithinWorkspace(input.path);
	const parentPath = resolveWithinWorkspace(path.dirname(input.path));

	await mkdir(parentPath, { recursive: true });
	await writeFile(resolvedPath, input.content, "utf8");

	return { bytesWritten: Buffer.byteLength(input.content), path: input.path };
};
