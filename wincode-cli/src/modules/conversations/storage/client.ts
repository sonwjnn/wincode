import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { resolveLocalDatabasePath } from "./path";
import { conversationSchema } from "./schema";

export type ConversationDatabase = ReturnType<
	typeof drizzle<typeof conversationSchema>
>;

const applyPragmas = (sqlite: Database): void => {
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec("PRAGMA busy_timeout = 5000;");
};

export const createDatabase = (
	path: string = resolveLocalDatabasePath()
): { db: ConversationDatabase; sqlite: Database } => {
	const sqlite = new Database(path, { create: true });
	applyPragmas(sqlite);
	const db = drizzle(sqlite, { schema: conversationSchema });
	return { db, sqlite };
};
