import { createRequire } from "node:module";
import type { FileLockGuard, NodeFileHandle, tryOpenLock } from "@lickle/lock";
import type { SessionWriterLockAdapter } from "./session-writer-lock-adapter";

type NativeLockModule = Readonly<{
	Lock: Readonly<{ Exclusive: 0 }>;
	tryOpenLock: typeof tryOpenLock;
}>;

const require = createRequire(import.meta.url);

const acquire = async (lockPath: string) => {
	const nativeLock = require("@lickle/lock") as NativeLockModule;
	const guard: FileLockGuard<NodeFileHandle> | undefined =
		await nativeLock.tryOpenLock(lockPath, nativeLock.Lock.Exclusive);
	if (guard === undefined) {
		return;
	}
	const handle = guard.handle;
	return {
		truncate: (length: number) => handle.truncate(length),
		writeFile: (content: string) => handle.writeFile(content),
		release: () => guard.drop(),
	};
};

export const windowsSessionWriterLockAdapter = {
	acquire,
	primitive: "LockFileEx",
} satisfies SessionWriterLockAdapter;
