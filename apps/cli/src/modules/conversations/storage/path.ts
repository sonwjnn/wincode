import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveUserDataDir } from "@/shared/paths/user-data-dir";

const DATABASE_FILE_NAME = "conversations.db";

export const resolveLocalDatabasePath = (): string => {
	const databasePath =
		process.env.WINCODE_LOCAL_DB_PATH ??
		join(resolveUserDataDir(), DATABASE_FILE_NAME);
	mkdirSync(dirname(databasePath), { recursive: true });
	return databasePath;
};
