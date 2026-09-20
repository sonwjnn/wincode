import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isObjectLike } from "@wincode/runtime-utils";
import type { ToolResourceLimits } from "../tools/resource-limits";
import { defaultWorkspaceSandbox, type WorkspacePolicy } from "../workspace";
import {
	CodingToolError,
	createFileObservation,
	type FileObservation,
	type FileSnapshot,
	isCodingToolError,
	type VersionedEditingContext,
} from "./contracts";
import {
	computeFileVersion,
	decodeLosslessText,
	type FileVersion,
	type LineRange,
	type LosslessText,
	lineRangeForLines,
} from "./model";

export type FileState = Readonly<{
	bytes: Uint8Array;
	fileVersion: FileVersion;
	text: LosslessText;
}>;

const hasErrorCode = (
	error: unknown,
	code: string
): error is NodeJS.ErrnoException =>
	isObjectLike(error) && "code" in error && error.code === code;

const errorForTextDecode = (
	error: unknown,
	filePath: string
): CodingToolError =>
	new CodingToolError(
		error instanceof Error && error.message.includes("NUL")
			? "binary-content"
			: "invalid-utf8",
		error instanceof Error
			? `${error.message} (${filePath})`
			: `Cannot edit '${filePath}' because it is not valid UTF-8.`,
		{
			details: { path: filePath },
			recovery: { action: "reread", path: filePath },
		}
	);

export const readVersionedFile = async (
	resolvedPath: string
): Promise<FileState> => {
	const bytes = new Uint8Array(await readFile(resolvedPath));
	let text: LosslessText;
	try {
		text = decodeLosslessText(bytes);
	} catch (error) {
		throw errorForTextDecode(error, resolvedPath);
	}
	return { bytes, fileVersion: computeFileVersion(bytes), text };
};

export const expandExternalPath = (inputPath: string): string => {
	if (inputPath === "~") {
		return homedir();
	}
	if (inputPath.startsWith("~/")) {
		return path.join(homedir(), inputPath.slice(2));
	}
	return inputPath;
};

export const resolveExistingTextPath = async (
	inputPath: string,
	allowExternalPath: boolean,
	sandbox: WorkspacePolicy = defaultWorkspaceSandbox
): Promise<string> =>
	allowExternalPath
		? realpath(path.resolve(expandExternalPath(inputPath)))
		: sandbox.resolveExistingPath(inputPath);

const resolveMissingPath = async (resolvedPath: string): Promise<string> => {
	const missingSegments = [path.basename(resolvedPath)];
	let current = path.dirname(resolvedPath);
	while (true) {
		try {
			const canonicalParent = await realpath(current);
			return path.join(canonicalParent, ...missingSegments);
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
			const parent = path.dirname(current);
			if (parent === current) {
				return resolvedPath;
			}
			missingSegments.unshift(path.basename(current));
			current = parent;
		}
	}
};

export const resolveNewTextPath = async (
	inputPath: string,
	allowExternalPath: boolean,
	sandbox: WorkspacePolicy = defaultWorkspaceSandbox
): Promise<string> => {
	const resolvedPath = allowExternalPath
		? path.resolve(expandExternalPath(inputPath))
		: await sandbox.resolveNewPath(inputPath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) {
			throw error;
		}
		return resolveMissingPath(resolvedPath);
	}
};

export const canonicalPath = async (
	inputPath: string,
	allowExternalPath: boolean,
	sandbox: WorkspacePolicy = defaultWorkspaceSandbox
): Promise<string> => {
	try {
		return await resolveExistingTextPath(inputPath, allowExternalPath, sandbox);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) {
			throw error;
		}
		return await resolveNewTextPath(inputPath, allowExternalPath, sandbox);
	}
};

export const snapshotForState = (
	resolvedPath: string,
	state: FileState
): FileSnapshot => ({
	algorithm: "sha256-128",
	bytes: new Uint8Array(state.bytes),
	createdAt: Date.now(),
	fileVersion: state.fileVersion,
	lineCount: state.text.lines.length,
	path: resolvedPath,
});
const canonicalLineRanges = (
	ranges: readonly LineRange[],
	maxObservedLines: number,
	resolvedPath: string
): LineRange[] => {
	const lines = new Set<number>();
	for (const range of ranges) {
		const endLine = range.endLine ?? range.startLine;
		for (let line = range.startLine; line <= endLine; line += 1) {
			lines.add(line);
			if (lines.size > maxObservedLines) {
				throw new CodingToolError(
					"observation-out-of-budget",
					`Observed lines exceed the configured limit for ${resolvedPath}.`,
					{
						details: { maxObservedLines, path: resolvedPath },
						recovery: { action: "reread", path: resolvedPath },
					}
				);
			}
		}
	}
	return lineRangeForLines([...lines]);
};
export const assertObservedLineBudget = (
	ranges: readonly LineRange[],
	maxObservedLines: number,
	resolvedPath: string
): void => {
	canonicalLineRanges(ranges, maxObservedLines, resolvedPath);
};
export const persistFileObservation = async ({
	context,
	limits,
	path: resolvedPath,
	seenLines,
	snapshotPersisted = false,
	state,
}: {
	context: VersionedEditingContext;
	limits: ToolResourceLimits;
	path: string;
	seenLines: readonly LineRange[];
	snapshotPersisted?: boolean;
	state: FileState;
}): Promise<FileObservation> => {
	const persist = async (): Promise<FileObservation> => {
		const snapshotAvailable =
			state.bytes.byteLength <= limits.read.maxSnapshotBytes;
		if (snapshotAvailable && !snapshotPersisted) {
			try {
				await context.store.saveSnapshot(snapshotForState(resolvedPath, state));
			} catch (error) {
				if (isCodingToolError(error)) {
					throw error;
				}
				throw new CodingToolError(
					"snapshot-persistence-failed",
					"Could not persist the file snapshot.",
					{
						details: { path: resolvedPath },
						recovery: { action: "reread", path: resolvedPath },
					}
				);
			}
		}
		const existing = await context.store.getObservation(
			context.sessionId,
			resolvedPath,
			state.fileVersion
		);
		const latest = await context.store.getLatestObservation(
			context.sessionId,
			resolvedPath
		);
		const observation = createFileObservation({
			createdAt: Math.max(Date.now(), (latest?.createdAt ?? 0) + 1),
			fileVersion: state.fileVersion,
			path: resolvedPath,
			sessionId: context.sessionId,
			seenLines: canonicalLineRanges(
				[...(existing?.seenLines ?? []), ...seenLines],
				limits.read.maxObservedLines,
				resolvedPath
			),
			snapshotAvailable:
				snapshotAvailable || (existing?.snapshotAvailable ?? false),
		});
		await context.store.saveObservation(observation);
		return observation;
	};
	const transaction = context.store.withSnapshotTransaction;
	return transaction ? transaction(persist) : persist();
};

const hasWriteModeBit = (mode: number, bit: number): boolean =>
	Math.floor(mode / bit) % 2 === 1;

const fileNotWritableError = (resolvedPath: string): CodingToolError =>
	new CodingToolError(
		"file-not-writable",
		`File is not writable: ${resolvedPath}.`,
		{
			details: { path: resolvedPath },
			recovery: { action: "correct-input", path: resolvedPath },
		}
	);

const mutationLocks = new Map<string, Promise<void>>();

export const withFileMutationLock = async <T>(
	resolvedPath: string,
	operation: () => Promise<T>
): Promise<T> => {
	const previous = mutationLocks.get(resolvedPath) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	mutationLocks.set(resolvedPath, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (mutationLocks.get(resolvedPath) === current) {
			mutationLocks.delete(resolvedPath);
		}
	}
};
export const withSnapshotFailureCleanup = async <T>(
	context: VersionedEditingContext,
	snapshot: Pick<FileSnapshot, "fileVersion" | "path">,
	operation: () => Promise<T>
): Promise<T> => {
	try {
		return await operation();
	} catch (error) {
		const discard = context.store.discardSnapshot;
		if (discard) {
			await discard(snapshot.path, snapshot.fileVersion).catch(() => undefined);
		}
		throw error;
	}
};

export const atomicReplaceFile = async (
	resolvedPath: string,
	bytes: Uint8Array,
	expectedFileVersion?: FileVersion
): Promise<void> => {
	const existingMode = await lstat(resolvedPath)
		.then((metadata) => metadata.mode % 0o1_0000)
		.catch((error: unknown) => {
			if (hasErrorCode(error, "ENOENT")) {
				return;
			}
			throw error;
		});
	if (
		existingMode !== undefined &&
		![0o200, 0o20, 0o2].some((bit) => hasWriteModeBit(existingMode, bit))
	) {
		throw fileNotWritableError(resolvedPath);
	}
	if (existingMode !== undefined) {
		try {
			await access(resolvedPath, constants.W_OK);
		} catch (error) {
			if (!(hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM"))) {
				throw error;
			}
			throw fileNotWritableError(resolvedPath);
		}
	}
	const temporaryPath = `${resolvedPath}.wincode-${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, bytes);
		if (existingMode !== undefined) {
			await chmod(temporaryPath, existingMode);
		}
		if (expectedFileVersion !== undefined) {
			const canonicalPath = await realpath(resolvedPath);
			if (canonicalPath !== resolvedPath) {
				throw new CodingToolError(
					"approved-path-changed",
					"The canonical edit path changed before replacement.",
					{ recovery: { action: "reread", path: resolvedPath } }
				);
			}
			const latest = await readVersionedFile(resolvedPath);
			expectFileVersion(latest.fileVersion, expectedFileVersion, resolvedPath);
		}
		await rename(temporaryPath, resolvedPath);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		if (hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM")) {
			throw fileNotWritableError(resolvedPath);
		}
		throw error;
	}
};

export type CreatedParentDirectories = readonly string[];

export const createParentDirectories = async (
	resolvedPath: string
): Promise<CreatedParentDirectories> => {
	const parentPath = path.dirname(resolvedPath);
	const missing: string[] = [];
	let current = parentPath;
	while (true) {
		try {
			await lstat(current);
			break;
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
			missing.push(current);
			const parent = path.dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}
	const created: string[] = [];
	for (const directory of [...missing].reverse()) {
		try {
			await mkdir(directory);
			created.push(directory);
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) {
				const metadata = await lstat(directory);
				if (metadata.isDirectory()) {
					continue;
				}
			}
			await removeEmptyCreatedParents([...created].reverse());
			throw error;
		}
	}
	return created.reverse();
};

export const removeEmptyCreatedParents = async (
	directories: CreatedParentDirectories
): Promise<void> => {
	for (const directory of directories) {
		await rmdir(directory).catch(() => undefined);
	}
};

export const expectFileVersion = (
	actual: FileVersion,
	expected: FileVersion | undefined,
	pathName: string
): void => {
	if (expected === undefined) {
		throw new CodingToolError(
			"expected-file-version",
			`Write requires the current File Version before overwriting '${pathName}'.`,
			{
				details: { path: pathName },
				recovery: { action: "provide-file-version", path: pathName },
			}
		);
	}
	if (actual === expected) {
		return;
	}
	throw new CodingToolError(
		"file-version-mismatch",
		`File Version changed for '${pathName}': expected ${expected}, got ${actual}.`,
		{
			details: { actual, expected, path: pathName },
			recovery: {
				action: "reread",
				currentFileVersion: actual,
				path: pathName,
			},
		}
	);
};

export const parseUtf8Content = (content: string): FileState => {
	const bytes = new TextEncoder().encode(content);
	let text: LosslessText;
	try {
		text = decodeLosslessText(bytes);
	} catch (error) {
		throw errorForTextDecode(error, "write content");
	}
	return { bytes, fileVersion: computeFileVersion(bytes), text };
};
