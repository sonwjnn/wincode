import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import { sessionId } from "../support/identifiers";

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
	expect(await store.getCompactions(sessionId("missing-session"))).toEqual([]);
});
test("adds edit mode to a database created before versioned editing", async () => {
	const directory = await mkdtemp(join("/tmp", "wincode-edit-mode-schema-"));
	const databasePath = join(directory, "session.sqlite");
	let sqlite: Database | undefined;
	try {
		const legacy = new Database(databasePath);
		legacy.exec(`
			CREATE TABLE session (
				id TEXT PRIMARY KEY NOT NULL,
				workspace_id TEXT,
				title TEXT,
				pinned INTEGER DEFAULT 0 NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_message_at INTEGER,
				model_json TEXT,
				variant TEXT
			);
		`);
		legacy.close();

		const opened = createDatabase(databasePath);
		sqlite = opened.sqlite;
		const columns = sqlite.query("PRAGMA table_info(session)").all() as Array<{
			name: string;
		}>;
		expect(columns.map(({ name }) => name)).toContain("edit_mode");
	} finally {
		sqlite?.close();
		await rm(directory, { force: true, recursive: true });
	}
});
