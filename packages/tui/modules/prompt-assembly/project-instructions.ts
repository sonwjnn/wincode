import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { getProjectRoots } from "@/shared/paths/project-roots";

export const PROJECT_INSTRUCTION_FILE_NAME = "AGENTS.md";
export const MAX_PROJECT_INSTRUCTION_SOURCE_CHARS = 12_000;
export const MAX_PROJECT_INSTRUCTION_TOTAL_BYTES = 24 * 1024;
const MAX_PROJECT_INSTRUCTION_SOURCE_BYTES =
	MAX_PROJECT_INSTRUCTION_SOURCE_CHARS * 4 + 3;
const MAX_PROJECT_INSTRUCTION_READ_BYTES =
	MAX_PROJECT_INSTRUCTION_SOURCE_BYTES + 1;
const PROJECT_INSTRUCTION_OPEN_FLAGS =
	constants.O_NOFOLLOW ?? constants.O_RDONLY;

export type ProjectInstructionFileStats = {
	readonly isFile: () => boolean;
	readonly isSymbolicLink?: () => boolean;
	readonly mtimeMs?: number;
	readonly size?: number;
};

export type ProjectInstructionFileSystem = {
	readonly readFile: (
		path: string,
		maxBytes?: number
	) => Promise<Uint8Array | string>;
	readonly stat?: (path: string) => Promise<ProjectInstructionFileStats>;
};

export type ProjectInstructionSource = {
	readonly byteLength: number;
	readonly characterLength: number;
	/** Body text is retained only in memory for prompt assembly, never persisted. */
	readonly content: string;
	readonly contentHash: string;
	readonly sourcePath: string;
};

export type ProjectInstructionDiagnosticCode =
	| "invalid-utf8"
	| "not-a-file"
	| "project-total-too-large"
	| "read-error"
	| "source-too-large";

export type ProjectInstructionDiagnostic = {
	readonly byteLength?: number;
	readonly characterLength?: number;
	readonly code: ProjectInstructionDiagnosticCode;
	readonly message: string;
	readonly reason: ProjectInstructionDiagnosticCode;
	readonly sourcePath: string;
};

export type ProjectInstructionSnapshot = {
	readonly diagnostics: readonly ProjectInstructionDiagnostic[];
	readonly sources: readonly ProjectInstructionSource[];
	readonly totalByteLength: number;
	readonly workspace: string;
};

export type ProjectInstructionSnapshotInput = {
	readonly fs?: ProjectInstructionFileSystem;
	/** Root-to-workspace order; useful for deterministic application seams. */
	readonly projectRoots?: readonly string[];
	/** Canonical sandbox workspace used for provenance-relative source paths. */
	readonly provenanceWorkspace?: string;
	readonly workspace: string;
};

type FileMetadata =
	| { readonly kind: "missing" }
	| {
			readonly kind: "present";
			readonly isFile: boolean;
			readonly isSymbolicLink: boolean;
			readonly mtimeMs: number | null;
			readonly size: number | null;
	  }
	| { readonly kind: "error" };

type Candidate = {
	readonly absolutePath: string;
	readonly sourcePath: string;
};

const defaultFileSystem: ProjectInstructionFileSystem = {
	readFile: async (path, maxBytes = MAX_PROJECT_INSTRUCTION_READ_BYTES) => {
		const file = await open(path, PROJECT_INSTRUCTION_OPEN_FLAGS);
		try {
			const buffer = new Uint8Array(maxBytes);
			let byteLength = 0;
			while (byteLength < maxBytes) {
				const { bytesRead } = await file.read(
					buffer,
					byteLength,
					maxBytes - byteLength,
					byteLength
				);
				if (bytesRead === 0) {
					break;
				}
				byteLength += bytesRead;
			}
			return buffer.slice(0, byteLength);
		} finally {
			await file.close();
		}
	},
	stat: async (path) => lstat(path),
};

const isMissingError = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	return error.code === "ENOENT";
};

const isByteArray = (value: Uint8Array | string): value is Uint8Array =>
	typeof value !== "string";

const countCharacters = (content: string): number => Array.from(content).length;

const toBytes = (value: Uint8Array | string): Uint8Array =>
	isByteArray(value) ? value : new TextEncoder().encode(value);

const encodeMetadata = (metadata: FileMetadata): string => {
	if (metadata.kind === "missing") {
		return "missing";
	}
	if (metadata.kind === "error") {
		return "error";
	}
	let fileKind = "other";
	if (metadata.isSymbolicLink) {
		fileKind = "symlink";
	} else if (metadata.isFile) {
		fileKind = "file";
	}
	return [
		"present",
		fileKind,
		metadata.size ?? "unknown",
		metadata.mtimeMs ?? "unknown",
	].join(":");
};
const LEADING_DOT_SLASH = /^\.\//u;

const escapePath = (path: string): string =>
	path.replaceAll("\\", "/").replace(LEADING_DOT_SLASH, "");

const relativeSourcePath = (workspace: string, path: string): string => {
	const candidate = escapePath(relative(workspace, path));
	return candidate.length > 0 ? candidate : PROJECT_INSTRUCTION_FILE_NAME;
};

const sourceCandidates = (
	workspace: string,
	projectRoots: readonly string[]
): readonly Candidate[] =>
	projectRoots.map((root) => {
		const absolutePath = resolve(root, PROJECT_INSTRUCTION_FILE_NAME);
		return {
			absolutePath,
			sourcePath: relativeSourcePath(workspace, absolutePath),
		};
	});

const readMetadata = async (
	fileSystem: ProjectInstructionFileSystem,
	path: string
): Promise<FileMetadata> => {
	if (fileSystem.stat === undefined) {
		return { kind: "error" };
	}
	try {
		const fileStats = await fileSystem.stat(path);
		return {
			isFile: fileStats.isFile(),
			isSymbolicLink: fileStats.isSymbolicLink?.() ?? false,
			kind: "present",
			mtimeMs: fileStats.mtimeMs ?? null,
			size: fileStats.size ?? null,
		};
	} catch (error) {
		return isMissingError(error) ? { kind: "missing" } : { kind: "error" };
	}
};

const metadataKey = (
	workspace: string,
	provenanceWorkspace: string,
	candidates: readonly Candidate[],
	metadata: readonly FileMetadata[]
): string =>
	[
		workspace,
		provenanceWorkspace,
		...candidates.map((candidate, index) => {
			const candidateMetadata = metadata[index] ?? { kind: "error" as const };
			return `${candidate.absolutePath}:${encodeMetadata(candidateMetadata)}`;
		}),
	].join("\n");

const diagnosticMessage = (code: ProjectInstructionDiagnosticCode): string => {
	switch (code) {
		case "invalid-utf8":
			return "Project instruction source is not valid UTF-8.";
		case "source-too-large":
			return `Project instruction source exceeds the ${MAX_PROJECT_INSTRUCTION_SOURCE_CHARS}-character limit.`;
		case "project-total-too-large":
			return `Project instructions exceed the ${MAX_PROJECT_INSTRUCTION_TOTAL_BYTES}-byte limit.`;
		case "not-a-file":
			return "Project instruction source is not a regular file.";
		default:
			return "Project instruction source could not be read.";
	}
};

const invalidDiagnostic = (
	sourcePath: string,
	code: ProjectInstructionDiagnosticCode,
	byteLength?: number,
	characterLength?: number
): ProjectInstructionDiagnostic => ({
	...(byteLength === undefined ? {} : { byteLength }),
	...(characterLength === undefined ? {} : { characterLength }),
	code,
	message: diagnosticMessage(code),
	reason: code,
	sourcePath,
});
type SourceLimit = {
	readonly byteLength?: number;
	readonly characterLength?: number;
};

const sourceLimitExceeded = (
	value: Uint8Array | string
): SourceLimit | undefined => {
	if (isByteArray(value)) {
		return value.byteLength > MAX_PROJECT_INSTRUCTION_SOURCE_BYTES
			? { byteLength: value.byteLength }
			: undefined;
	}
	let characterLength = 0;
	for (const _character of value) {
		characterLength += 1;
		if (characterLength > MAX_PROJECT_INSTRUCTION_SOURCE_CHARS) {
			return { characterLength };
		}
	}
	return;
};

const readSource = async (
	fileSystem: ProjectInstructionFileSystem,
	candidate: Candidate
): Promise<
	| { readonly bytes: Uint8Array; readonly content: string }
	| { readonly diagnostic: ProjectInstructionDiagnostic }
	| { readonly missing: true }
> => {
	let value: Uint8Array | string;
	try {
		value = await fileSystem.readFile(
			candidate.absolutePath,
			MAX_PROJECT_INSTRUCTION_READ_BYTES
		);
	} catch (error) {
		if (isMissingError(error)) {
			return { missing: true };
		}
		return {
			diagnostic: invalidDiagnostic(candidate.sourcePath, "read-error"),
		};
	}
	const limit = sourceLimitExceeded(value);
	if (limit !== undefined) {
		return {
			diagnostic: invalidDiagnostic(
				candidate.sourcePath,
				"source-too-large",
				limit.byteLength,
				limit.characterLength
			),
		};
	}
	const bytes = toBytes(value);
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return {
			diagnostic: invalidDiagnostic(
				candidate.sourcePath,
				"invalid-utf8",
				bytes.byteLength
			),
		};
	}
	const characterLength = countCharacters(content);
	if (characterLength > MAX_PROJECT_INSTRUCTION_SOURCE_CHARS) {
		return {
			diagnostic: invalidDiagnostic(
				candidate.sourcePath,
				"source-too-large",
				bytes.byteLength,
				characterLength
			),
		};
	}
	return { bytes, content };
};
const loadSourceCandidate = async (
	fileSystem: ProjectInstructionFileSystem,
	candidate: Candidate,
	fileMetadata: FileMetadata
): Promise<Awaited<ReturnType<typeof readSource>>> => {
	if (fileMetadata.kind === "missing") {
		return { missing: true };
	}
	if (
		fileMetadata.kind === "present" &&
		(fileMetadata.isSymbolicLink || !fileMetadata.isFile)
	) {
		return {
			diagnostic: invalidDiagnostic(
				candidate.sourcePath,
				"not-a-file",
				fileMetadata.size ?? undefined
			),
		};
	}
	if (
		fileMetadata.kind === "present" &&
		fileMetadata.size !== null &&
		fileMetadata.size > MAX_PROJECT_INSTRUCTION_SOURCE_BYTES
	) {
		return {
			diagnostic: invalidDiagnostic(
				candidate.sourcePath,
				"source-too-large",
				fileMetadata.size
			),
		};
	}
	return readSource(fileSystem, candidate);
};

const freezeSnapshot = (
	snapshot: ProjectInstructionSnapshot
): ProjectInstructionSnapshot =>
	Object.freeze({
		...snapshot,
		diagnostics: Object.freeze([...snapshot.diagnostics]),
		sources: Object.freeze(
			snapshot.sources.map((source) => Object.freeze(source))
		),
	});

/**
 * Loads only AGENTS.md from the active root-to-workspace chain. Each source is
 * independently validated and omitted on failure; no source is truncated.
 */
export const createProjectInstructionSnapshot = async (
	input: ProjectInstructionSnapshotInput,
	cache?: Map<string, ProjectInstructionSnapshot>
): Promise<ProjectInstructionSnapshot> => {
	const workspace = resolve(input.workspace);
	const provenanceWorkspace = resolve(input.provenanceWorkspace ?? workspace);
	const fileSystem = input.fs ?? defaultFileSystem;
	const roots = input.projectRoots ?? getProjectRoots(workspace);
	const candidates = sourceCandidates(provenanceWorkspace, roots);
	const metadata = await Promise.all(
		candidates.map((candidate) =>
			readMetadata(fileSystem, candidate.absolutePath)
		)
	);
	const key = metadataKey(workspace, provenanceWorkspace, candidates, metadata);
	const cacheable = metadata.every(({ kind }) => kind !== "error");
	if (cacheable) {
		const cached = cache?.get(key);
		if (cached !== undefined) {
			return cached;
		}
	}

	const diagnostics: ProjectInstructionDiagnostic[] = [];
	const sources: ProjectInstructionSource[] = [];
	let totalByteLength = 0;
	for (const [index, candidate] of candidates.entries()) {
		const loaded = await loadSourceCandidate(
			fileSystem,
			candidate,
			metadata[index] ?? { kind: "error" }
		);
		if ("missing" in loaded) {
			continue;
		}
		if ("diagnostic" in loaded) {
			diagnostics.push(loaded.diagnostic);
			continue;
		}
		const byteLength = loaded.bytes.byteLength;
		const characterLength = countCharacters(loaded.content);
		if (totalByteLength + byteLength > MAX_PROJECT_INSTRUCTION_TOTAL_BYTES) {
			diagnostics.push(
				invalidDiagnostic(
					candidate.sourcePath,
					"project-total-too-large",
					byteLength,
					characterLength
				)
			);
			continue;
		}
		sources.push({
			byteLength,
			characterLength,
			content: loaded.content,
			contentHash: createHash("sha256").update(loaded.bytes).digest("hex"),
			sourcePath: candidate.sourcePath,
		});
		totalByteLength += byteLength;
	}

	const snapshot = freezeSnapshot({
		diagnostics,
		sources,
		totalByteLength,
		workspace: provenanceWorkspace,
	});
	const canCacheSnapshot =
		cacheable && diagnostics.every(({ code }) => code !== "read-error");
	if (canCacheSnapshot) {
		cache?.set(key, snapshot);
	}
	return snapshot;
};

export const loadProjectInstructions = createProjectInstructionSnapshot;
