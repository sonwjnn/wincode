import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { LocalConversationDatabase } from "./client";

export const localMigrationsFolder = join(
	import.meta.dir,
	"../../../../drizzle/local"
);

export const runLocalMigrations = (db: LocalConversationDatabase): void => {
	migrate(db, { migrationsFolder: localMigrationsFolder });
};
