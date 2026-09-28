import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	createDatabase,
	SessionDatabaseResetRequiredError,
} from "@/modules/sessions/storage/client";
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
test("requires resetting local data instead of converting an incompatible reasoning schema", async () => {
	const directory = await mkdtemp(join("/tmp", "wincode-edit-mode-schema-"));
	const databasePath = join(directory, "session.sqlite");
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
			INSERT INTO session VALUES (
				'session-a', NULL, NULL, 0, 1, 1, NULL, NULL, 'thinking'
			);
			CREATE TABLE session_compaction (
				id TEXT PRIMARY KEY NOT NULL,
				session_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				prior_compaction_id TEXT,
				summary_json TEXT NOT NULL,
				first_kept_ui_message_id TEXT NOT NULL,
				first_kept_assistant_part_index INTEGER,
				through_message_ui_id TEXT NOT NULL,
				tokens_before INTEGER NOT NULL,
				estimated_tokens_after INTEGER NOT NULL,
				trigger TEXT NOT NULL,
				focus TEXT,
				summarization_model_json TEXT NOT NULL,
				summarization_variant TEXT,
				summarization_usage_json TEXT,
				created_at INTEGER NOT NULL,
				completed_at INTEGER NOT NULL
			);
			INSERT INTO session_compaction VALUES (
				'compaction-a', 'session-a', 1, NULL, '[]', 'message-a',
				NULL, 'message-a', 10, 5, 'manual', NULL,
				'{"providerId":"provider-a","modelId":"model-a"}',
				'high', NULL, 1, 1
			);
			CREATE TABLE session_record (
				record_id TEXT PRIMARY KEY NOT NULL,
				session_id TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				delegation_json TEXT,
				model_json TEXT NOT NULL,
				outcome_json TEXT NOT NULL,
				messages_json TEXT NOT NULL,
				version INTEGER NOT NULL,
				position INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			INSERT INTO session_record VALUES (
				'record-a', 'session-a', 'turn-a', 'build', NULL,
				'{"providerId":"provider-a","modelId":"model-a","variant":"high"}',
				'{"kind":"assistant"}',
				'[{"id":"assistant-a","role":"assistant","metadata":{"variant":"none"},"parts":[{"type":"text","text":"kept"}]}]',
				1, 1, 1
			);
		`);
		legacy.close();

		expect(() => createDatabase(databasePath)).toThrow(
			SessionDatabaseResetRequiredError
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
