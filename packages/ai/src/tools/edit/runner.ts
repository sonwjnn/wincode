import { readFile, writeFile } from "node:fs/promises";
import { defaultWorkspaceSandbox } from "../../workspace";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
} from "../resource-limits";
import { buildEditDiff, buildFullFileEditDiff } from "./diff";
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

export const runEditTool = async (
	input: EditInput,
	options: ResourceLimitOptions = {}
): Promise<EditOutput> => {
	const resolvedPath = await defaultWorkspaceSandbox.resolveExistingPath(
		input.path
	);
	const content = await readFile(resolvedPath, "utf8");
	const isFullFileEdit = "content" in input;
	let nextContent: string;
	let replacements: number;
	if (isFullFileEdit) {
		nextContent = input.content;
		replacements = 1;
	} else {
		const { find, replace } = input;
		if (find === undefined || replace === undefined) {
			throw new Error("Invalid edit input: find and replace are required");
		}
		replacements = countReplacements(content, find, input.replaceAll);
		if (replacements === 0) {
			throw new Error(`Could not find text in ${input.path}`);
		}
		nextContent = input.replaceAll
			? content.split(find).join(replace)
			: content.replace(find, replace);
	}
	if (nextContent === content) {
		throw new Error(`Edit produced no content changes: ${input.path}`);
	}
	const limits = options.resourceLimits ?? getToolResourceLimits();
	const editDiff = isFullFileEdit
		? buildFullFileEditDiff(content, nextContent, input.path, limits.edit)
		: buildEditDiff(content, nextContent, input.path, limits.edit);

	await writeFile(resolvedPath, nextContent, "utf8");

	return { editDiff, path: input.path, replacements };
};
