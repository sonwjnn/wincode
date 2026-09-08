import { defineConfig } from "drizzle-kit";
import { resolveLocalDatabasePath } from "./modules/sessions/storage/path";

export default defineConfig({
	dbCredentials: {
		url: `file:${resolveLocalDatabasePath()}`,
	},
	dialect: "sqlite",
	schema: "./modules/sessions/storage/schema.ts",
});
