import { readFile } from "node:fs/promises";
import { defaultWorkspaceSandbox } from "../../workspace";
import { truncateUtf8 } from "../output-bounds";
import type { ReadInput, ReadOutput } from "./schema";

const READ_CONTENT_MAX_BYTES = 6000;

export const runReadTool = async (input: ReadInput): Promise<ReadOutput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
		input.path
	);
	const content = await readFile(resolvedPath, "utf8");

	const truncatedContent = truncateUtf8(content, READ_CONTENT_MAX_BYTES);
	return {
		content: truncatedContent,
		path: input.path,
		...(truncatedContent.length < content.length ? { truncated: true } : {}),
	};
};
