import * as fs from "node:fs";
import * as path from "node:path";
import {
	resolveOperatingSystemUserDataDir,
	resolveUserDataDir,
} from "@/shared/paths/user-data-dir";
import { getErrorCode } from "@/shared/utils/error-log-fields";
import { SessionWriterLockFailureError } from "./session-writer-lock";

const DATABASE_FILE_NAME = "sessions.db";
const ATTACHMENT_DIRECTORY_NAME = "attachments";
const SNAPSHOT_DIRECTORY_NAME = "file-snapshots";
const DATABASE_PATH_INDEX_DIRECTORY_NAME = "session-writer-locks";
const DATABASE_PATH_INDEX_VERSION = 2;
type DatabaseIdentity = Readonly<{
	device: string;
	inode: string;
	birthtime: string;
}>;

const resolveDatabasePathIndex = (
	indexPath: string,
	identity: DatabaseIdentity
): string | undefined => {
	let contents: string;
	try {
		contents = fs.readFileSync(indexPath, "utf8");
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") {
			return;
		}
		throw error;
	}

	const value: unknown = JSON.parse(contents);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("The local Session database path index is invalid.");
	}
	const storedPath: unknown = Reflect.get(value, "path");
	if (
		Reflect.get(value, "version") !== DATABASE_PATH_INDEX_VERSION ||
		Reflect.get(value, "device") !== identity.device ||
		Reflect.get(value, "inode") !== identity.inode ||
		Reflect.get(value, "birthtime") !== identity.birthtime ||
		typeof storedPath !== "string" ||
		!path.isAbsolute(storedPath)
	) {
		throw new Error("The local Session database path index is invalid.");
	}

	const indexedPath = storedPath;
	const storedIdentity = fs.statSync(indexedPath, { bigint: true });
	if (
		!storedIdentity.isFile() ||
		storedIdentity.dev.toString() !== identity.device ||
		storedIdentity.ino.toString() !== identity.inode ||
		storedIdentity.birthtimeNs.toString() !== identity.birthtime
	) {
		throw new Error(
			"The indexed local Session database path no longer identifies this database."
		);
	}
	return indexedPath;
};

const createDatabasePathIndex = (
	indexPath: string,
	databasePath: string,
	identity: DatabaseIdentity
): string => {
	const temporaryPath = `${indexPath}.${crypto.randomUUID()}.tmp`;
	let temporaryHandle: number | undefined;
	try {
		temporaryHandle = fs.openSync(temporaryPath, "wx", 0o600);
		fs.writeFileSync(
			temporaryHandle,
			JSON.stringify({
				birthtime: identity.birthtime,
				device: identity.device,
				inode: identity.inode,
				path: databasePath,
				version: DATABASE_PATH_INDEX_VERSION,
			})
		);
		fs.fsyncSync(temporaryHandle);
		fs.closeSync(temporaryHandle);
		temporaryHandle = undefined;

		try {
			fs.linkSync(temporaryPath, indexPath);
			return databasePath;
		} catch (error) {
			if (getErrorCode(error) !== "EEXIST") {
				throw error;
			}
			const existingPath = resolveDatabasePathIndex(indexPath, identity);
			if (existingPath === undefined) {
				throw new Error("The local Session database path index disappeared.");
			}
			return existingPath;
		}
	} finally {
		if (temporaryHandle !== undefined) {
			fs.closeSync(temporaryHandle);
		}
		fs.rmSync(temporaryPath, { force: true });
	}
};

/**
 * Gives SQLite one stable pathname per local database identity. WAL sidecars
 * are keyed by pathname, so processes and aliases use the first configured name.
 * Retaining a symlink name also keeps its legacy WAL visible on reopening.
 */
export const resolveSessionDatabasePath = (databasePath: string): string => {
	if (databasePath === "" || databasePath === ":memory:") {
		return databasePath;
	}

	try {
		const absolutePath = path.resolve(databasePath);
		try {
			const info = fs.statSync(absolutePath);
			if (!info.isFile()) {
				throw new Error("The local Session database path is not a file.");
			}
		} catch (error) {
			if (getErrorCode(error) !== "ENOENT") {
				throw error;
			}
			try {
				fs.closeSync(fs.openSync(absolutePath, "wx"));
			} catch (createError) {
				if (getErrorCode(createError) !== "EEXIST") {
					throw createError;
				}
			}
		}

		const fileInfo = fs.statSync(absolutePath, { bigint: true });
		if (!fileInfo.isFile() || fileInfo.dev === 0n || fileInfo.ino === 0n) {
			throw new Error("The database file has no stable local identity.");
		}
		const identity = {
			birthtime: fileInfo.birthtimeNs.toString(),
			device: fileInfo.dev.toString(),
			inode: fileInfo.ino.toString(),
		};
		const indexDirectory = path.join(
			resolveOperatingSystemUserDataDir(),
			DATABASE_PATH_INDEX_DIRECTORY_NAME
		);
		fs.mkdirSync(indexDirectory, { recursive: true });
		const canonicalIndexDirectory = fs.realpathSync(indexDirectory);
		const identityHash = new Bun.CryptoHasher("sha256")
			.update(`${identity.device}:${identity.inode}:${identity.birthtime}`)
			.digest("hex");
		const indexPath = path.join(
			canonicalIndexDirectory,
			`${identityHash}.database-path`
		);
		return (
			resolveDatabasePathIndex(indexPath, identity) ??
			createDatabasePathIndex(indexPath, absolutePath, identity)
		);
	} catch (error) {
		if (error instanceof SessionWriterLockFailureError) {
			throw error;
		}
		throw new SessionWriterLockFailureError(error);
	}
};

export const resolveLocalDatabasePath = (): string => {
	const databasePath =
		process.env.WINCODE_LOCAL_DB_PATH ??
		path.join(resolveUserDataDir(), DATABASE_FILE_NAME);
	fs.mkdirSync(path.dirname(databasePath), { recursive: true });
	return databasePath;
};

export const resolveLocalAttachmentRoot = (
	databasePath: string = resolveLocalDatabasePath()
): string => path.join(path.dirname(databasePath), ATTACHMENT_DIRECTORY_NAME);
export const resolveLocalSnapshotRoot = (
	databasePath: string = resolveLocalDatabasePath()
): string => path.join(path.dirname(databasePath), SNAPSHOT_DIRECTORY_NAME);
