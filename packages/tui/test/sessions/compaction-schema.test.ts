import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";

test("initializes the current compaction schema in a fresh local database", async () => {
	const directory = await mkdtemp(join("/tmp", "wincode-compaction-schema-"));
	const databasePath = join(directory, "session.sqlite");
	const { db } = createDatabase(databasePath);

	const columns = db.$client
		.query("PRAGMA table_info(session_compaction)")
		.all() as Array<{ name: string }>;
	const columnNames = columns.map(({ name }) => name);

	expect(columnNames).toContain("estimated_tokens_after");
	expect(columnNames).not.toContain("tokens_after");

	const store = createDrizzleSessionStore(db);
	expect(await store.getCompactions("missing-session")).toEqual([]);
});
