import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import { getErrorCode } from "@/shared/utils/error-log-fields";
import type { SessionWriterLockAdapter } from "./session-writer-lock-adapter";

const acquire = async (lockPath: string) => {
	const handle: FileHandle = await open(lockPath, "a+", 0o600);
	try {
		await tryLockExclusive(handle.fd);
	} catch (error) {
		await handle.close().catch(() => undefined);
		const errorCode = getErrorCode(error);
		if (errorCode === "EAGAIN" || errorCode === "EWOULDBLOCK") {
			return;
		}
		throw error;
	}

	return {
		truncate: (length: number) => handle.truncate(length),
		writeFile: (content: string) => handle.writeFile(content),
		release: () => handle.close(),
	};
};

export const posixSessionWriterLockAdapter = {
	acquire,
	primitive: "flock",
} satisfies SessionWriterLockAdapter;
