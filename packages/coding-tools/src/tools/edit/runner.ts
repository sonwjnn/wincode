import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceSandbox } from "../../workspace";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
} from "../resource-limits";
import { buildEditDiff, buildFullFileEditDiff } from "./diff";
import type { EditInput, EditOutput } from "./schema";

const HASHLINE_PATTERN = /^([1-9]\d*):([a-z]{2})$/u;
const HASHLINE_SEPARATOR_PATTERN = /[\s,;]+/u;
const HASHLINE_LINE_ENDING_PATTERN = /\r?\n/u;
const FNV_OFFSET_BASIS = 2_166_136_261;
const FNV_PRIME = 16_777_619;
const HASHLINE_ALPHABET_OFFSET = 97;
const HASHLINE_ALPHABET_SIZE = 26;

const hashLine = (line: string): string => {
	let hash = FNV_OFFSET_BASIS;
	for (const byte of Buffer.from(line, "utf8")) {
		// biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a requires 32-bit arithmetic.
		hash ^= byte;
		// biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a requires unsigned 32-bit arithmetic.
		hash = Math.imul(hash, FNV_PRIME) >>> 0;
	}
	return (
		String.fromCharCode(
			HASHLINE_ALPHABET_OFFSET + (hash % HASHLINE_ALPHABET_SIZE)
		) +
		String.fromCharCode(
			HASHLINE_ALPHABET_OFFSET +
				// biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a extracts the second byte.
				((hash >>> 8) % HASHLINE_ALPHABET_SIZE)
		)
	);
};

const parseHashlineAnchors = (
	lineHashes: string,
	path: string
): Array<{ hash: string; line: number }> => {
	const anchors = lineHashes
		.split(HASHLINE_SEPARATOR_PATTERN)
		.filter(Boolean)
		.map((anchor) => {
			const match = HASHLINE_PATTERN.exec(anchor);
			if (!match) {
				throw new Error(`Invalid hashline anchor '${anchor}' in ${path}`);
			}
			return { hash: match[2] as string, line: Number(match[1]) };
		});
	if (anchors.length === 0) {
		throw new Error(`Hashline edit requires at least one anchor: ${path}`);
	}
	for (let index = 1; index < anchors.length; index += 1) {
		if (anchors[index]?.line !== (anchors[index - 1]?.line ?? 0) + 1) {
			throw new Error(`Hashline anchors must be contiguous in ${path}`);
		}
	}
	return anchors;
};

const applyHashlineEdit = (
	content: string,
	input: Extract<EditInput, { lineHashes: string }>
): { nextContent: string; replacements: number } => {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(HASHLINE_LINE_ENDING_PATTERN);
	const anchors = parseHashlineAnchors(input.lineHashes, input.path);
	for (const anchor of anchors) {
		const line = lines[anchor.line - 1];
		if (line === undefined) {
			throw new Error(`Hashline anchor points past end of ${input.path}`);
		}
		const actualHash = hashLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		if (actualHash !== anchor.hash) {
			throw new Error(
				`Hashline mismatch at line ${anchor.line} in ${input.path}: expected '${anchor.hash}', got '${actualHash}'`
			);
		}
	}
	if (input.insertAfter && anchors.length !== 1) {
		throw new Error(`Hashline insertAfter requires one anchor: ${input.path}`);
	}
	const first = anchors[0]?.line ?? 0;
	const last = anchors.at(-1)?.line ?? 0;
	const replacementLines = input.content.split(HASHLINE_LINE_ENDING_PATTERN);
	const start = input.insertAfter ? last : first - 1;
	const deleteCount = input.insertAfter ? 0 : last - first + 1;
	lines.splice(start, deleteCount, ...replacementLines);
	return { nextContent: lines.join(newline), replacements: deleteCount || 1 };
};

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
const resolveEditPath = async (
	inputPath: string,
	allowExternalPath: boolean
): Promise<string> =>
	allowExternalPath
		? path.resolve(inputPath)
		: defaultWorkspaceSandbox.resolveExistingPath(inputPath);

export const runEditTool = async (
	input: EditInput,
	options: ResourceLimitOptions = {}
): Promise<EditOutput> => {
	const resolvedPath = await resolveEditPath(
		input.path,
		options.allowExternalPath === true
	);
	const content = await readFile(resolvedPath, "utf8");
	const isHashlineEdit = "lineHashes" in input;
	const isFullFileEdit = "content" in input && !isHashlineEdit;
	let nextContent: string;
	let replacements: number;
	if (isHashlineEdit) {
		({ nextContent, replacements } = applyHashlineEdit(content, input));
	} else if (isFullFileEdit) {
		nextContent = input.content;
		replacements = 1;
	} else {
		if (!("find" in input)) {
			throw new Error("Invalid edit input: find and replace are required");
		}
		const { find, replace } = input;
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
