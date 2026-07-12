import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Local server config owns DATABASE_URL. Existing process env remains preferred in CI/deploy.
config({ path: new URL("../../apps/server/.env", import.meta.url) });

export default defineConfig({
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
	dialect: "postgresql",
	out: "./drizzle/cloud",
	schema: "./src/schema/index.ts",
});
