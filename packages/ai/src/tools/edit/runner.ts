import { readFile, writeFile } from "node:fs/promises";
import { defaultWorkspaceSandbox } from "../../workspace";
import type { EditInput, EditOutput } from "./schema";

const countReplacements = (
	content: string,
	find: string,
	replaceAll?: boolean
) => {
	if (replaceAll) {
		return content.split(find).length - 1;
	}

	if (content.includes(find)) {
		return 1;
	}

	return 0;
};

export const runEditTool = async (input: EditInput): Promise<EditOutput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
		input.path
	);
	const content = await readFile(resolvedPath, "utf8");
	const replacements = countReplacements(content, input.find, input.replaceAll);

	if (replacements === 0) {
		throw new Error(`Could not find text in ${input.path}`);
	}

	const nextContent = input.replaceAll
		? content.split(input.find).join(input.replace)
		: content.replace(input.find, input.replace);

	await writeFile(resolvedPath, nextContent, "utf8");

	return { path: input.path, replacements };
};
