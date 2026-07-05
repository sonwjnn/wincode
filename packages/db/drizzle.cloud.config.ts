import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
	dialect: "postgresql",
	out: "./drizzle/cloud",
	schema: "./src/schema/index.ts",
});
