import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { resolveLocalDatabasePath } from "./path";
import { localConversationSchema } from "./schema";

export type LocalConversationDatabase = ReturnType<
	typeof drizzle<typeof localConversationSchema>
>;

const applyPragmas = (sqlite: Database): void => {
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec("PRAGMA busy_timeout = 5000;");
};

export const createLocalDatabase = (
	path: string = resolveLocalDatabasePath()
): { db: LocalConversationDatabase; sqlite: Database } => {
	const sqlite = new Database(path, { create: true });
	applyPragmas(sqlite);
	const db = drizzle(sqlite, { schema: localConversationSchema });
	return { db, sqlite };
};
