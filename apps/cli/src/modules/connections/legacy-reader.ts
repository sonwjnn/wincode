import { readFile } from "node:fs/promises";
import {
	DEFAULT_SESSION_PATH,
	type StoredSession,
} from "../auth/session-store";

export const DEFAULT_LEGACY_WINCODE_SESSION_PATH = DEFAULT_SESSION_PATH;

export async function readLegacyWincodeSession(
	path = DEFAULT_LEGACY_WINCODE_SESSION_PATH
): Promise<StoredSession | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as StoredSession;
	} catch {
		return null;
	}
}
