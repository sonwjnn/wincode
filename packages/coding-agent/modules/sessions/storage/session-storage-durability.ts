import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	createAtomicPathPublisher,
	moveWindowsPathDurably,
} from "./session-path-publish";

export const SESSION_DIRECTORY_STAGING_PREFIX = ".wincode-directory-";

export type SessionDirectorySync = (directory: string) => Promise<void>;

/**
 * Windows has no documented FlushFileBuffers contract for directory handles.
 * Windows callers must use the write-through path operations below instead.
 * The optional override exists only for deterministic durability-failure tests.
 */
export const syncDirectoryAfterDurablePathChange = async (
	directory: string,
	syncDirectory: SessionDirectorySync,
	forceOnWindows = false
): Promise<void> => {
	if (process.platform === "win32" && !forceOnWindows) {
		return;
	}
	await syncDirectory(directory);
};

/** Creates a directory entry durably without relying on directory fsync on Windows. */
const createSessionDirectoryDurably = async (
	directory: string,
	mode: number,
	syncDirectory: SessionDirectorySync,
	forceOnWindows: boolean
): Promise<void> => {
	const absoluteDirectory = path.resolve(directory);
	const parent = path.dirname(absoluteDirectory);
	if (process.platform === "win32") {
		const stagingDirectory = await fs.mkdtemp(
			path.join(parent, SESSION_DIRECTORY_STAGING_PREFIX)
		);
		try {
			moveWindowsPathDurably(stagingDirectory, absoluteDirectory);
		} finally {
			await fs
				.rm(stagingDirectory, { force: true, recursive: true })
				.catch(() => undefined);
		}
	} else {
		await fs.mkdir(absoluteDirectory, { mode });
	}
	await syncDirectoryAfterDurablePathChange(
		parent,
		syncDirectory,
		forceOnWindows
	);
};

/** Creates parent directories using platform-native durable namespace operations. */
export const ensureSessionDirectoryTreeDurably = async (
	directory: string,
	mode: number,
	syncDirectory: SessionDirectorySync,
	forceOnWindows = false,
	notDirectoryMessage = "Session storage path is not a directory."
): Promise<void> => {
	const absoluteDirectory = path.resolve(directory);
	try {
		const existing = await fs.stat(absoluteDirectory);
		if (!existing.isDirectory()) {
			throw new Error(notDirectoryMessage);
		}
		await syncDirectoryAfterDurablePathChange(
			path.dirname(absoluteDirectory),
			syncDirectory,
			forceOnWindows
		);
		return;
	} catch (error) {
		if (error instanceof Error && error.message === notDirectoryMessage) {
			throw error;
		}
		if (!isCode(error, "ENOENT")) {
			throw error;
		}
	}

	const parent = path.dirname(absoluteDirectory);
	if (parent !== absoluteDirectory) {
		await ensureSessionDirectoryTreeDurably(
			parent,
			mode,
			syncDirectory,
			forceOnWindows,
			notDirectoryMessage
		);
	}
	try {
		await createSessionDirectoryDurably(
			absoluteDirectory,
			mode,
			syncDirectory,
			forceOnWindows
		);
	} catch (error) {
		if (!isCode(error, "EEXIST")) {
			throw error;
		}
		const existing = await fs.stat(absoluteDirectory);
		if (!existing.isDirectory()) {
			throw new Error(notDirectoryMessage);
		}
		await syncDirectoryAfterDurablePathChange(
			parent,
			syncDirectory,
			forceOnWindows
		);
	}
};

export const removeSessionFileDurably = async (
	filePath: string,
	cleanupRoot: string,
	syncDirectory: SessionDirectorySync,
	removeFile?: (filePath: string) => Promise<void>
): Promise<void> => {
	if (process.platform === "win32" && removeFile === undefined) {
		const removedDirectory = path.join(cleanupRoot, ".removed");
		await ensureSessionDirectoryTreeDurably(
			removedDirectory,
			0o700,
			syncDirectory
		);
		const removedPath = path.join(
			removedDirectory,
			`${crypto.randomUUID()}.removed`
		);
		try {
			moveWindowsPathDurably(filePath, removedPath);
		} catch (error) {
			if (isCode(error, "ENOENT")) {
				return;
			}
			throw error;
		}
		// The durable move already removed the authoritative name. Failure here
		// can only leave an ignored cleanup artifact in the control directory.
		await fs.unlink(removedPath).catch(() => undefined);
		return;
	}

	try {
		if (removeFile === undefined) {
			await fs.unlink(filePath);
		} else {
			await removeFile(filePath);
		}
	} catch (error) {
		if (isCode(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	await syncDirectoryAfterDurablePathChange(
		path.dirname(filePath),
		syncDirectory
	);
};

const isCode = (error: unknown, code: string): boolean =>
	typeof error === "object" &&
	error !== null &&
	Reflect.get(error, "code") === code;

/** Publishes a staged file without replacing an existing destination. */
export const publishSessionFileNoReplaceDurably = async (
	stagingPath: string,
	destination: string,
	syncDirectory: SessionDirectorySync,
	forceOnWindows = false,
	afterPublish?: () => void
): Promise<void> => {
	if (process.platform === "win32") {
		moveWindowsPathDurably(stagingPath, destination);
	} else if (
		(process.platform === "darwin" || process.platform === "linux") &&
		(process.arch === "arm64" || process.arch === "x64")
	) {
		createAtomicPathPublisher().publish(stagingPath, destination);
	} else {
		await fs.link(stagingPath, destination);
	}
	afterPublish?.();
	await syncDirectoryAfterDurablePathChange(
		path.dirname(destination),
		syncDirectory,
		forceOnWindows
	);
};

/** Replaces a staged file and waits for the Windows namespace update to reach disk. */
export const replaceSessionFileDurably = async (
	stagingPath: string,
	destination: string,
	syncDirectory: SessionDirectorySync,
	forceOnWindows = false
): Promise<void> => {
	if (process.platform === "win32") {
		moveWindowsPathDurably(stagingPath, destination, true);
	} else {
		await fs.rename(stagingPath, destination);
	}
	await syncDirectoryAfterDurablePathChange(
		path.dirname(destination),
		syncDirectory,
		forceOnWindows
	);
};

/** Publishes a staged session directory; both changed parent directories are synced on POSIX. */
export const publishSessionDirectoryDurably = async (
	stagingPath: string,
	destination: string,
	syncDirectory: SessionDirectorySync,
	forceOnWindows = false,
	afterPublish?: () => void
): Promise<void> => {
	if (process.platform === "win32") {
		createAtomicPathPublisher().publish(stagingPath, destination);
	} else {
		await fs.rename(stagingPath, destination);
	}
	afterPublish?.();
	const sourceParent = path.dirname(stagingPath);
	const destinationParent = path.dirname(destination);
	await syncDirectoryAfterDurablePathChange(
		sourceParent,
		syncDirectory,
		forceOnWindows
	);
	if (destinationParent !== sourceParent) {
		await syncDirectoryAfterDurablePathChange(
			destinationParent,
			syncDirectory,
			forceOnWindows
		);
	}
};
