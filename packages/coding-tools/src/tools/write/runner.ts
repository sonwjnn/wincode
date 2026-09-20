import { lstat, rm } from "node:fs/promises";
import { isObjectLike } from "@wincode/runtime-utils";
import {
	CodingToolError,
	defaultVersionedEditingContext,
	isCodingToolError,
	type VersionedEditingContext,
} from "../../versioned/contracts";
import {
	atomicReplaceFile,
	createParentDirectories,
	expectFileVersion,
	type FileState,
	parseUtf8Content,
	persistFileObservation,
	readVersionedFile,
	removeEmptyCreatedParents,
	resolveExistingTextPath,
	resolveNewTextPath,
	withFileMutationLock,
	withSnapshotFailureCleanup,
} from "../../versioned/filesystem";
import type { FileVersion } from "../../versioned/model";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
	type ToolResourceLimits,
} from "../resource-limits";
import type { WriteInput, WriteOutput } from "./schema";

type WriteOptions = ResourceLimitOptions & {
	versionedEditing?: VersionedEditingContext;
};

const isMissingPath = (error: unknown): boolean =>
	isObjectLike(error) && "code" in error && error.code === "ENOENT";

const allLines = (state: FileState) => {
	const endLine = state.text.lines.length;
	if (endLine === 0) {
		return [];
	}
	return [endLine === 1 ? { startLine: 1 } : { endLine, startLine: 1 }];
};
const assertWriteTargetUnchanged = async ({
	existing,
	pathName,
	resolvedPath,
}: {
	existing: FileState | null;
	pathName: string;
	resolvedPath: string;
}): Promise<void> => {
	let latest: FileState | null = null;
	try {
		latest = await readVersionedFile(resolvedPath);
	} catch (error) {
		if (!isMissingPath(error)) {
			throw error;
		}
	}
	if (existing === null) {
		if (latest !== null) {
			throw new CodingToolError(
				"file-created-during-write",
				`Write target appeared during creation of '${pathName}'.`,
				{ recovery: { action: "reread", path: pathName } }
			);
		}
		return;
	}
	if (latest === null) {
		throw new CodingToolError(
			"file-removed-during-write",
			`Write target disappeared before '${pathName}' could be replaced.`,
			{ recovery: { action: "reread", path: pathName } }
		);
	}
	expectFileVersion(latest.fileVersion, existing.fileVersion, pathName);
};

const restoreWriteAfterFailure = async ({
	existing,
	newState,
	resolvedPath,
}: {
	existing: FileState | null;
	newState: FileState;
	resolvedPath: string;
}): Promise<boolean> => {
	try {
		const current = await readVersionedFile(resolvedPath);
		if (current.fileVersion !== newState.fileVersion) {
			return false;
		}
		if (existing === null) {
			await rm(resolvedPath, { force: true });
		} else {
			await atomicReplaceFile(resolvedPath, existing.bytes);
		}
		return true;
	} catch {
		return false;
	}
};

const persistWriteObservation = async ({
	context,
	existing,
	input,
	limits,
	newState,
	resolvedPath,
	snapshotPersisted,
}: {
	context: VersionedEditingContext;
	existing: FileState | null;
	input: WriteInput;
	limits: ToolResourceLimits;
	newState: FileState;
	resolvedPath: string;
	snapshotPersisted: boolean;
}): Promise<Awaited<ReturnType<typeof persistFileObservation>>> => {
	try {
		return await persistFileObservation({
			context,
			limits,
			path: resolvedPath,
			seenLines: allLines(newState),
			snapshotPersisted,
			state: newState,
		});
	} catch (error) {
		const restored = await restoreWriteAfterFailure({
			existing,
			newState,
			resolvedPath,
		});
		if (!restored) {
			throw new CodingToolError(
				"mutation-persistence-failed",
				"Write persistence failed and the file could not be safely restored.",
				{
					details: { path: input.path },
					recovery: { action: "reread", path: input.path },
				}
			);
		}
		if (isCodingToolError(error)) {
			throw error;
		}
		throw new CodingToolError(
			"mutation-persistence-failed",
			"Write persistence failed after the file was restored.",
			{
				details: { path: input.path },
				recovery: { action: "reread", path: input.path },
			}
		);
	}
};

export const runWriteTool = async (
	input: WriteInput,
	options: WriteOptions = {}
): Promise<WriteOutput> => {
	const context = options.versionedEditing ?? defaultVersionedEditingContext;
	const limits: ToolResourceLimits =
		options.resourceLimits ?? getToolResourceLimits();
	const allowExternalPath = options.allowExternalPath === true;
	let resolvedPath = await resolveNewTextPath(input.path, allowExternalPath);
	let existing: FileState | null = null;
	try {
		const candidateMetadata = await lstat(resolvedPath);
		if (!candidateMetadata.isFile()) {
			throw new CodingToolError(
				"not-a-file",
				`Write target is not a regular file: ${input.path}.`,
				{ recovery: { action: "correct-input", path: input.path } }
			);
		}
		resolvedPath = await resolveExistingTextPath(input.path, allowExternalPath);
		const metadata = await lstat(resolvedPath);
		if (!metadata.isFile()) {
			throw new CodingToolError(
				"not-a-file",
				`Write target is not a regular file: ${input.path}.`,
				{ recovery: { action: "correct-input", path: input.path } }
			);
		}
		existing = await readVersionedFile(resolvedPath);
		expectFileVersion(
			existing.fileVersion,
			input.expectedVersion as FileVersion | undefined,
			input.path
		);
	} catch (error) {
		if (!isMissingPath(error)) {
			throw error;
		}
		if (input.expectedVersion !== undefined) {
			throw new CodingToolError(
				"file-not-found",
				`Cannot apply expected File Version because '${input.path}' does not exist.`,
				{ recovery: { action: "reread", path: input.path } }
			);
		}
	}

	const newState = parseUtf8Content(input.content);
	return withFileMutationLock(resolvedPath, () =>
		withSnapshotFailureCleanup(
			context,
			{ fileVersion: newState.fileVersion, path: resolvedPath },
			async () => {
				const createdParents = await createParentDirectories(resolvedPath);
				try {
					await assertWriteTargetUnchanged({
						existing,
						pathName: input.path,
						resolvedPath,
					});
					await atomicReplaceFile(resolvedPath, newState.bytes);
					const observation = await persistWriteObservation({
						context,
						existing,
						input,
						limits,
						newState,
						resolvedPath,
						snapshotPersisted: false,
					});
					return {
						bytesWritten: newState.bytes.byteLength,
						newFileVersion: newState.fileVersion,
						observationId: observation.id,
						oldFileVersion: existing?.fileVersion,
						path: input.path,
						seenLines: [...observation.seenLines],
					};
				} catch (error) {
					if (existing === null) {
						await removeEmptyCreatedParents(createdParents);
					}
					throw error;
				}
			}
		)
	);
};
