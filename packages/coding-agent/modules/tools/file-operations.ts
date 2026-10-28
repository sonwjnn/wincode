import {
	editOutputSchema,
	readOutputSchema,
	writeOutputSchema,
} from "./schemas";

/**
 * A deterministic file effect a completed built-in Tool Call declared through
 * its output contract. Compaction persists the cumulative sets so a repeated
 * summary cannot lose which files were read or modified just because their
 * Tool Calls fell outside the newest summary span.
 */
export type ToolFileOperation = Readonly<{
	kind: "modified" | "read";
	path: string;
}>;

const normalizePath = (candidate: string): string | undefined => {
	const trimmed = candidate.trim();
	return trimmed.length === 0 ? undefined : trimmed;
};

const readOperation = (output: unknown): ToolFileOperation[] => {
	const parsed = readOutputSchema.safeParse(output);
	if (!parsed.success) {
		return [];
	}
	// Directories and symlink targets report no File Version; only a text file
	// read is a durable file observation.
	if (parsed.data.fileVersion === undefined) {
		return [];
	}
	const candidate = normalizePath(parsed.data.path);
	return candidate === undefined ? [] : [{ kind: "read", path: candidate }];
};

const writeOperation = (output: unknown): ToolFileOperation[] => {
	const parsed = writeOutputSchema.safeParse(output);
	if (!parsed.success) {
		return [];
	}
	const candidate = normalizePath(parsed.data.path);
	return candidate === undefined ? [] : [{ kind: "modified", path: candidate }];
};

const editOperations = (output: unknown): ToolFileOperation[] => {
	const parsed = editOutputSchema.safeParse(output);
	if (!parsed.success) {
		return [];
	}
	// One-file edits report `path`; an apply_patch batch reports `files`.
	const paths = new Set<string>();
	for (const file of parsed.data.files ?? []) {
		const candidate = normalizePath(file.path);
		if (candidate !== undefined) {
			paths.add(candidate);
		}
	}
	const singlePath =
		parsed.data.newFileVersion === undefined
			? undefined
			: normalizePath(parsed.data.path ?? "");
	if (singlePath !== undefined) {
		paths.add(singlePath);
	}
	return [...paths]
		.sort()
		.map((candidate) => ({ kind: "modified", path: candidate }));
};

/**
 * The file effects one completed built-in Tool Call declares. Tools without a
 * file-path output contract contribute nothing: a Shell command may touch any
 * file, but it cannot declare which one deterministically.
 */
export const toolFileOperations = (
	toolName: string,
	output: unknown
): readonly ToolFileOperation[] => {
	switch (toolName) {
		case "edit":
			return editOperations(output);
		case "read":
			return readOperation(output);
		case "write":
			return writeOperation(output);
		default:
			return [];
	}
};
