import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceSandbox } from "../../workspace";
import type { WriteInput, WriteOutput } from "./schema";

export const runWriteTool = async (input: WriteInput): Promise<WriteOutput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveNewPath(input.path);
	const parentPath = path.dirname(resolvedPath);

	await mkdir(parentPath, { recursive: true });
	await writeFile(resolvedPath, input.content, "utf8");

	return { bytesWritten: Buffer.byteLength(input.content), path: input.path };
};
