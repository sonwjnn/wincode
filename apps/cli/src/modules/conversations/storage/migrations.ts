import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { ConversationDatabase } from "./client";

export const migrationsFolder = join(
	import.meta.dir,
	"../../../../drizzle/local"
);

export const runMigrations = (db: ConversationDatabase): void => {
	migrate(db, { migrationsFolder });
};
