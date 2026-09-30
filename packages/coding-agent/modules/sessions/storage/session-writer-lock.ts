import { mkdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { EXECUTION_MODES, type ExecutionMode } from "@/shared/execution-mode";
import type { SessionId } from "@/shared/identifiers";
import type {
	SessionWriterLockAdapter,
	SessionWriterLockAdapterHandle,
} from "./session-writer-lock-adapter";
import { posixSessionWriterLockAdapter } from "./session-writer-lock-posix-adapter";
import { windowsSessionWriterLockAdapter } from "./session-writer-lock-windows-adapter";

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

	constructor(
		cause: unknown,
		message = "The Session Writer OS lock could not be established."
	) {
		super(message, { cause });
		this.name = "SessionWriterLockFailureError";
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
const SESSION_WRITER_LOCK_ADAPTERS: Readonly<
	Record<string, Readonly<Record<string, SessionWriterLockAdapter>>>
> = {
	darwin: {
		arm64: posixSessionWriterLockAdapter,
		x64: posixSessionWriterLockAdapter,
	},
	linux: {
		arm64: posixSessionWriterLockAdapter,
		x64: posixSessionWriterLockAdapter,
	},
	win32: {
		x64: windowsSessionWriterLockAdapter,
	},
};

export const resolveSessionWriterLockAdapter = (
	platform: string,
	arch: string
): SessionWriterLockAdapter => {
	const platformAdapters = Object.hasOwn(SESSION_WRITER_LOCK_ADAPTERS, platform)
		? SESSION_WRITER_LOCK_ADAPTERS[platform]
		: undefined;
	const adapter =
		platformAdapters !== undefined && Object.hasOwn(platformAdapters, arch)
			? platformAdapters[arch]
			: undefined;
	if (adapter !== undefined) {
		return adapter;
	}
	const message = `Unsupported Session Writer lock target: ${platform}/${arch}.`;
	throw new SessionWriterLockFailureError(new Error(message), message);
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
	const adapter = resolveSessionWriterLockAdapter(
		process.platform,
		process.arch
	);
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

	let acquiredLock: SessionWriterLockAdapterHandle | undefined;
	try {
		acquiredLock = await adapter.acquire(lockPath);
	} catch (error) {
		throw new SessionWriterLockFailureError(error);
	}
	if (acquiredLock === undefined) {
		throw new SessionInUseError(await readOwner(lockPath));
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
		await acquiredLock.truncate(0);
		await acquiredLock.writeFile(JSON.stringify(metadata));
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
			await acquiredLock.release();
		},
	};
};
