import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FileMentionUIPart } from "@wincode/ai";
import {
	createWorkspaceSandbox,
	type WorkspacePolicy,
} from "@wincode/ai/workspace";
import type { FileMentionOption } from "../types";
import { getFileMentionOptions } from "./file-mention-options";
import {
	compareCanonicalRelativePaths,
	getExtensionlessFileStem,
} from "./file-mention-path";
import {
	findFileMentionRanges,
	normalizeFileMentionPath,
} from "./mention-grammar";

const DEFAULT_MAX_FILE_BYTES = 24_000;
const DEFAULT_MAX_TOTAL_BYTES = 48_000;
const DEFAULT_MAX_DIRECTORY_DEPTH = 3;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 200;
const BINARY_SAMPLE_BYTES = 8000;
const MAX_AMBIGUOUS_FALLBACK_CANDIDATES = 8;

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

type ResolvedMention = {
	canonicalPath: string;
	realPath: string;
};

type FindFallbackMatches = (
	mentionPath: string
) => Promise<FileMentionOption[]>;

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

const getFallbackFileMatches = (
	options: FileMentionOption[],
	mentionPath: string
) => {
	const normalizedMentionPath = mentionPath.toLowerCase();

	return options
		.filter((option) => {
			if (option.type !== "file") {
				return false;
			}

			const basename = path.posix.basename(option.path).toLowerCase();
			return (
				basename === normalizedMentionPath ||
				getExtensionlessFileStem(basename) === normalizedMentionPath
			);
		})
		.toSorted((left, right) =>
			compareCanonicalRelativePaths(left.path, right.path)
		);
};

const formatAmbiguousMentionError = (
	mentionPath: string,
	matches: FileMentionOption[]
) => {
	const candidates = matches
		.slice(0, MAX_AMBIGUOUS_FALLBACK_CANDIDATES)
		.map((option) => option.path);
	const omittedCount = matches.length - candidates.length;
	const omittedText =
		omittedCount > 0 ? `; ${omittedCount} more candidate(s) omitted` : "";

	return `Ambiguous file mention "${mentionPath}". Use a relative path to choose one. Candidates: ${candidates.join(", ")}${omittedText}.`;
};

const createFallbackMatcher =
	(policy: WorkspacePolicy): FindFallbackMatches =>
	async (mentionPath) => {
		const options = await getFileMentionOptions({ root: policy.root });
		return getFallbackFileMatches(options, mentionPath);
	};

const resolveMentionPath = async (
	policy: WorkspacePolicy,
	mentionPath: string,
	findFallbackMatches: FindFallbackMatches
): Promise<ResolvedMention> => {
	try {
		const realPath = await policy.resolveExistingPath(mentionPath);
		return {
			canonicalPath: policy.relativePath(realPath) || mentionPath,
			realPath,
		};
	} catch (literalError) {
		if (mentionPath.includes("/") || isWorkspaceEscapeError(literalError)) {
			throw literalError;
		}

		let matches: FileMentionOption[];
		try {
			matches = await findFallbackMatches(mentionPath);
		} catch {
			throw literalError;
		}

		if (matches.length === 0) {
			throw literalError;
		}

		if (matches.length > 1) {
			throw new Error(formatAmbiguousMentionError(mentionPath, matches));
		}

		const match = matches[0];
		if (!match) {
			throw literalError;
		}

		const realPath = await policy.resolveExistingPath(match.path);
		return {
			canonicalPath: match.path,
			realPath,
		};
	}
};
const isWorkspaceEscapeError = (error: unknown) =>
	error instanceof Error && error.message.startsWith("Path escapes workspace:");

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
	const findFallbackMatches = createFallbackMatcher(policy);
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	let remainingBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	const mentionPaths = getMentionPaths(text);
	const resolvedPaths = new Set<string>();
	const parts: FileMentionUIPart[] = [];

	for (const mentionPath of mentionPaths) {
		if (remainingBytes <= 0) {
			parts.push(
				createErrorPart(mentionPath, "Mention context limit reached.")
			);
			continue;
		}

		let canonicalMentionPath = mentionPath;
		try {
			const resolvedMention = await resolveMentionPath(
				policy,
				mentionPath,
				findFallbackMatches
			);
			canonicalMentionPath = resolvedMention.canonicalPath;
			if (resolvedPaths.has(canonicalMentionPath)) {
				continue;
			}
			resolvedPaths.add(canonicalMentionPath);

			const fileStats = await stat(resolvedMention.realPath);
			const part = fileStats.isDirectory()
				? await readDirectoryMention(
						policy,
						resolvedMention.realPath,
						canonicalMentionPath,
						maxFileBytes,
						options.maxDirectoryDepth ?? DEFAULT_MAX_DIRECTORY_DEPTH,
						options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES
					)
				: await readFileMention(
						resolvedMention.realPath,
						canonicalMentionPath,
						maxFileBytes
					);
			const budgetedPart = applyRemainingBudget(part, remainingBytes);

			remainingBytes -= Buffer.byteLength(budgetedPart.data.content, "utf8");
			parts.push(budgetedPart);
		} catch (error) {
			parts.push(
				createErrorPart(
					canonicalMentionPath,
					error instanceof Error ? error.message : "Could not resolve mention."
				)
			);
		}
	}

	return parts;
};
