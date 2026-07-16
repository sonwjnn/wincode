import { Pool } from "@neondatabase/serverless";
import { env } from "@wincode/env/server";
import { drizzle } from "drizzle-orm/neon-serverless";
// biome-ignore lint/performance/noNamespaceImport: Drizzle expects the full schema object.
import * as schema from "./schema";

// Drizzle PostgreSQL client over the Neon serverless driver (WebSocket Pool,
// pg-compatible). Runs on the Bun/Hono server runtime and is the sole ORM for
// cloud PostgreSQL (auth). Do not import into the Cloudflare web runtime without
// a driver compatibility review.
export function createDrizzleClient() {
	const pool = new Pool({ connectionString: env.DATABASE_URL });
	return drizzle(pool, { schema });
}

export type DrizzleClient = ReturnType<typeof createDrizzleClient>;
