import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceSandbox } from "../../workspace";
import type { WriteInput, WriteOutput } from "./schema";

const isAlreadyExistsError = (error: unknown): error is { code: "EEXIST" } =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === "EEXIST";

export const runWriteTool = async (input: WriteInput): Promise<WriteOutput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveNewPath(input.path);
	const parentPath = path.dirname(resolvedPath);

	await mkdir(parentPath, { recursive: true });
	try {
		await writeFile(resolvedPath, input.content, {
			encoding: "utf8",
			flag: "wx",
		});
	} catch (error) {
		if (isAlreadyExistsError(error)) {
			throw new Error(
				`File already exists: ${input.path}. Use the edit tool to modify it.`
			);
		}
		throw error;
	}

	return { bytesWritten: Buffer.byteLength(input.content), path: input.path };
};
