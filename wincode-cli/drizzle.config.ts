import { defineConfig } from "drizzle-kit";
import { resolveLocalDatabasePath } from "./src/modules/conversations/storage/path";

export default defineConfig({
	dbCredentials: {
		url: `file:${resolveLocalDatabasePath()}`,
	},
	dialect: "sqlite",
	schema: "./src/modules/conversations/storage/schema.ts",
});
