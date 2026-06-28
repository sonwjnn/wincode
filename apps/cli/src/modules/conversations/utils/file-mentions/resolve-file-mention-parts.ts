import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FileMentionUIPart } from "@wincode/ai";
import {
	createWorkspaceSandbox,
	type WorkspacePolicy,
} from "@wincode/ai/workspace";
import {
	findFileMentionRanges,
	normalizeFileMentionPath,
} from "./mention-grammar";

const DEFAULT_MAX_FILE_BYTES = 24_000;
const DEFAULT_MAX_TOTAL_BYTES = 48_000;
const DEFAULT_MAX_DIRECTORY_DEPTH = 3;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 200;
const BINARY_SAMPLE_BYTES = 8000;

type ResolveFileMentionPartsOptions = {
	maxDirectoryDepth?: number;
	maxDirectoryEntries?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
	root?: string;
};

type ByteLimitResult = {
	content: string;
	truncated: boolean;
};

const getMentionPaths = (text: string) => {
	const paths: string[] = [];
	const seen = new Set<string>();

	for (const range of findFileMentionRanges(text)) {
		const mentionPath = normalizeFileMentionPath(range.query);
		if (!mentionPath || seen.has(mentionPath)) {
			continue;
		}

		seen.add(mentionPath);
		paths.push(mentionPath);
	}

	return paths;
};

const clampContentToBytes = (
	content: string,
	maxBytes: number
): ByteLimitResult => {
	if (maxBytes <= 0) {
		return { content: "", truncated: true };
	}

	const contentBytes = Buffer.byteLength(content, "utf8");
	if (contentBytes <= maxBytes) {
		return { content, truncated: false };
	}

	return {
		content: Buffer.from(content).subarray(0, maxBytes).toString("utf8"),
		truncated: true,
	};
};

const createErrorPart = (
	mentionPath: string,
	error: string
): FileMentionUIPart => ({
	data: {
		byteLength: 0,
		content: "",
		error,
		kind: "file",
		path: mentionPath,
		truncated: false,
	},
	type: "data-fileMention",
});

const readFileMention = async (
	realPath: string,
	mentionPath: string,
	maxBytes: number
): Promise<FileMentionUIPart> => {
	const buffer = await readFile(realPath);
	const isBinary = buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0);
	if (isBinary) {
		return {
			data: {
				byteLength: buffer.byteLength,
				content: "[binary file omitted]",
				kind: "file",
				path: mentionPath,
				truncated: false,
			},
			type: "data-fileMention",
		};
	}

	const { content, truncated } = clampContentToBytes(
		buffer.toString("utf8"),
		maxBytes
	);

	return {
		data: {
			byteLength: buffer.byteLength,
			content,
			kind: "file",
			path: mentionPath,
			truncated,
		},
		type: "data-fileMention",
	};
};

const readDirectoryMention = async (
	policy: WorkspacePolicy,
	realPath: string,
	mentionPath: string,
	maxBytes: number,
	maxDepth: number,
	maxEntries: number
): Promise<FileMentionUIPart> => {
	const result = await policy.traverse({
		includeDirectories: true,
		includeFiles: true,
		maxDepth,
		maxEntries,
		path: realPath,
	});
	const lines = [`${mentionPath}/`];

	for (const entry of result.entries) {
		const suffix = entry.type === "directory" ? "/" : "";
		lines.push(
			`${"  ".repeat(entry.depth)}${path.basename(entry.absolutePath)}${suffix}`
		);
	}

	const rawContent = lines.join("\n");
	const { content, truncated: byteTruncated } = clampContentToBytes(
		rawContent,
		maxBytes
	);

	return {
		data: {
			byteLength: Buffer.byteLength(rawContent, "utf8"),
			content,
			kind: "directory",
			path: mentionPath,
			truncated: result.truncated || byteTruncated,
		},
		type: "data-fileMention",
	};
};

const applyRemainingBudget = (
	part: FileMentionUIPart,
	remainingBytes: number
): FileMentionUIPart => {
	const { content, truncated } = clampContentToBytes(
		part.data.content,
		remainingBytes
	);

	return {
		...part,
		data: {
			...part.data,
			content,
			truncated: part.data.truncated || truncated,
		},
	};
};

export const resolveFileMentionParts = async (
	text: string,
	options: ResolveFileMentionPartsOptions = {}
): Promise<FileMentionUIPart[]> => {
	const policy = createWorkspaceSandbox(options.root ?? process.cwd());
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	let remainingBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const mentionPaths = getMentionPaths(text);
	const parts: FileMentionUIPart[] = [];

	for (const mentionPath of mentionPaths) {
		if (remainingBytes <= 0) {
			parts.push(
				createErrorPart(mentionPath, "Mention context limit reached.")
			);
			continue;
		}

		try {
			const realPath = await policy.resolveExistingPath(mentionPath);
			const fileStats = await stat(realPath);
			const part = fileStats.isDirectory()
				? await readDirectoryMention(
						policy,
						realPath,
						mentionPath,
						maxFileBytes,
						options.maxDirectoryDepth ?? DEFAULT_MAX_DIRECTORY_DEPTH,
						options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES
					)
				: await readFileMention(realPath, mentionPath, maxFileBytes);
			const budgetedPart = applyRemainingBudget(part, remainingBytes);

			remainingBytes -= Buffer.byteLength(budgetedPart.data.content, "utf8");
			parts.push(budgetedPart);
		} catch (error) {
			parts.push(
				createErrorPart(
					mentionPath,
					error instanceof Error ? error.message : "Could not resolve mention."
				)
			);
		}
	}

	return parts;
};
