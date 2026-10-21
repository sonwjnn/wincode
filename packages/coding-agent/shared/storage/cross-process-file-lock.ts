import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorCode } from "@/shared/utils/error-log-fields";

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_ACQUIRE_TIMEOUT_MS = 60_000;

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

const awaitWithSignal = async <Result>(
	operation: Promise<Result>,
	signal: AbortSignal | undefined
): Promise<Result> => {
	throwIfAborted(signal);
	if (signal === undefined) {
		return operation;
	}
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => {
		aborted.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([operation, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
};

/**
 * Serializes one file-backed transaction across processes. A lock that cannot be
 * acquired is a hard failure; it is never bypassed by an unlocked write.
 */
export const withCrossProcessFileLock = async <Result>(
	lockPath: string,
	operation: () => Result | Promise<Result>,
	signal?: AbortSignal
): Promise<Result> => {
	await fs.mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });
	const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
	let lockHandle: fs.FileHandle | undefined;
	while (lockHandle === undefined) {
		throwIfAborted(signal);
		try {
			lockHandle = await fs.open(lockPath, "wx", 0o600);
		} catch (error) {
			if (getErrorCode(error) !== "EEXIST") {
				throw error;
			}
			if (Date.now() >= deadline) {
				throw new Error("Could not acquire the persistent storage lock.");
			}
			await awaitWithSignal(Bun.sleep(LOCK_RETRY_DELAY_MS), signal);
		}
	}

	try {
		await lockHandle.writeFile(
			JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid })
		);
		await lockHandle.sync();
		throwIfAborted(signal);
		return await operation();
	} finally {
		await lockHandle.close();
		await fs.rm(lockPath, { force: true });
	}
};
