import type { FileHandle } from "node:fs/promises";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import type { FileLockGuard, NodeFileHandle, tryOpenLock } from "@lickle/lock";
import { z } from "zod";
import { EXECUTION_MODES, type ExecutionMode } from "@/shared/execution-mode";
import type { SessionId } from "@/shared/identifiers";
import { getErrorCode } from "@/shared/utils/error-log-fields";

type NativeLockModule = Readonly<{
	Lock: Readonly<{ Exclusive: 0 }>;
	tryOpenLock: typeof tryOpenLock;
}>;
const require = createRequire(import.meta.url);

export type SessionWriterLockOwner = Readonly<{
	executionMode?: ExecutionMode;
	openedAt: string;
	pid: number;
	verification: "unverified";
}>;

export type SessionWriterLockOptions = Readonly<{
	executionMode?: ExecutionMode;
}>;

export type SessionWriterLock = Readonly<{
	release: () => Promise<void>;
}>;

const persistedOwnerSchema = z
	.object({
		executionMode: z.enum(EXECUTION_MODES).optional(),
		openedAt: z.string(),
		pid: z.number().int().positive(),
		version: z.literal(1),
	})
	.strict();

export class SessionInUseError extends Error {
	readonly code = "session_in_use" as const;
	readonly owner: SessionWriterLockOwner | undefined;

	constructor(owner?: SessionWriterLockOwner) {
		super("Session is already in use by another Session Host.");
		this.name = "SessionInUseError";
		this.owner = owner;
	}
}

export class SessionWriterLockFailureError extends Error {
	readonly code = "session_lock_failed" as const;

	constructor(cause: unknown) {
		super("The Session Writer OS lock could not be established.", { cause });
		this.name = "SessionWriterLockFailureError";
	}
}

export class LegacySessionLeaseError extends Error {
	readonly code = "legacy_session_lease" as const;

	constructor() {
		super(
			"A legacy SQLite Session Lease exists. Stop older Wincode processes before clearing it."
		);
		this.name = "LegacySessionLeaseError";
	}
}

const readOwner = async (
	lockPath: string
): Promise<SessionWriterLockOwner | undefined> => {
	try {
		const value: unknown = JSON.parse(await Bun.file(lockPath).text());
		const parsed = persistedOwnerSchema.safeParse(value);
		if (!parsed.success) {
			return;
		}
		return {
			...(parsed.data.executionMode === undefined
				? {}
				: { executionMode: parsed.data.executionMode }),
			openedAt: parsed.data.openedAt,
			pid: parsed.data.pid,
			verification: "unverified",
		};
	} catch {
		return;
	}
};
const acquirePosixLock = async (lockPath: string): Promise<FileHandle> => {
	let handle: FileHandle;
	try {
		handle = await open(lockPath, "a+", 0o600);
	} catch (error) {
		throw new SessionWriterLockFailureError(error);
	}
	try {
		await tryLockExclusive(handle.fd);
	} catch (error) {
		await handle.close().catch(() => undefined);
		const errorCode = getErrorCode(error);
		if (errorCode === "EAGAIN" || errorCode === "EWOULDBLOCK") {
			throw new SessionInUseError(await readOwner(lockPath));
		}
		throw new SessionWriterLockFailureError(error);
	}
	return handle;
};

/**
 * Acquires one process-owned lock for a local database file identity and Session ID.
 * Its persistent path sits beside the resolved database, so processes opening
 * the same database path share authority across user-data environment overrides.
 * The path must not be removed: processes could then lock different inodes for
 * the same Session ID.
 */
export const acquireSessionWriterLock = async (
	databasePath: string,
	sessionId: SessionId,
	options: SessionWriterLockOptions = {}
): Promise<SessionWriterLock> => {
	let lockPath: string;
	try {
		const canonicalDatabasePath = await realpath(databasePath);
		const databaseIdentity = await stat(canonicalDatabasePath, {
			bigint: true,
		});
		if (databaseIdentity.dev === 0n || databaseIdentity.ino === 0n) {
			throw new Error("The database file has no stable local identity.");
		}
		const lockDirectory = path.join(
			path.dirname(canonicalDatabasePath),
			".wincode-session-writer-locks"
		);
		await mkdir(lockDirectory, { mode: 0o700, recursive: true });
		const canonicalLockDirectory = await realpath(lockDirectory);
		const lockName = new Bun.CryptoHasher("sha256")
			.update(`${databaseIdentity.dev}:${databaseIdentity.ino}\0${sessionId}`)
			.digest("hex");
		lockPath = path.join(canonicalLockDirectory, `${lockName}.lock`);
	} catch (error) {
		throw new SessionWriterLockFailureError(error);
	}

	let guard: FileLockGuard<NodeFileHandle> | undefined;
	let posixHandle: FileHandle | undefined;
	if (process.platform === "linux" || process.platform === "darwin") {
		posixHandle = await acquirePosixLock(lockPath);
	} else {
		try {
			const nativeLock = require("@lickle/lock") as NativeLockModule;
			guard = await nativeLock.tryOpenLock(lockPath, nativeLock.Lock.Exclusive);
		} catch (error) {
			throw new SessionWriterLockFailureError(error);
		}
		if (guard === undefined) {
			throw new SessionInUseError(await readOwner(lockPath));
		}
	}

	const metadataHandle = posixHandle ?? guard?.handle;
	if (metadataHandle === undefined) {
		throw new SessionWriterLockFailureError(
			new Error("The Session Writer lock handle is unavailable.")
		);
	}
	const metadata = {
		...(options.executionMode === undefined
			? {}
			: { executionMode: options.executionMode }),
		openedAt: new Date().toISOString(),
		pid: process.pid,
		version: 1,
	};
	try {
		await metadataHandle.truncate(0);
		await metadataHandle.writeFile(JSON.stringify(metadata));
	} catch {
		// Owner metadata is diagnostic; the held OS lock remains authoritative.
	}

	let released = false;
	return {
		release: async () => {
			if (released) {
				return;
			}
			released = true;
			if (posixHandle !== undefined) {
				await posixHandle.close();
			} else if (guard !== undefined) {
				await guard.drop();
			}
		},
	};
};
