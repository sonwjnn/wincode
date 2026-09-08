import { defineConfig } from "drizzle-kit";
import { resolveLocalDatabasePath } from "./modules/conversations/storage/path";

export default defineConfig({
	dbCredentials: {
		url: `file:${resolveLocalDatabasePath()}`,
	},
	dialect: "sqlite",
	schema: "./modules/conversations/storage/schema.ts",
});
