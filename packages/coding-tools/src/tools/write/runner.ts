import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceSandbox } from "../../workspace";
import type { ResourceLimitOptions } from "../resource-limits";
import type { WriteInput, WriteOutput } from "./schema";

export const runWriteTool = async (
	input: WriteInput,
	options: ResourceLimitOptions = {}
): Promise<WriteOutput> => {
	const isExternal = options.allowExternalPath === true;
	const candidatePath = isExternal
		? path.resolve(input.path)
		: await defaultWorkspaceSandbox.resolveNewPath(input.path);
	let targetExists = true;
	try {
		await lstat(candidatePath);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			targetExists = false;
		} else {
			throw error;
		}
	}

	let resolvedPath = candidatePath;
	if (!isExternal && targetExists) {
		resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
			input.path
		);
	}
	const parentPath = path.dirname(resolvedPath);

	await mkdir(parentPath, { recursive: true });
	await writeFile(resolvedPath, input.content, {
		encoding: "utf8",
		flag: targetExists ? "w" : "wx",
	});

	return { bytesWritten: Buffer.byteLength(input.content), path: input.path };
};
