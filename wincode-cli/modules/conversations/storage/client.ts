import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { resolveLocalDatabasePath } from "./path";
import { conversationSchema } from "./schema";

export type ConversationDatabase = ReturnType<
	typeof drizzle<typeof conversationSchema>
>;

const applyPragmas = (sqlite: Database): void => {
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec("PRAGMA busy_timeout = 5000;");
};
const initializeSchema = (sqlite: Database): void => {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS conversation_workspace (
			id TEXT PRIMARY KEY NOT NULL,
			root_path TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE UNIQUE INDEX IF NOT EXISTS conversation_workspace_root_path_unique
			ON conversation_workspace (root_path);

		CREATE TABLE IF NOT EXISTS conversation_attachment (
			attachment_id TEXT PRIMARY KEY NOT NULL,
			blob_key TEXT NOT NULL,
			byte_length INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			integrity_version INTEGER DEFAULT 1 NOT NULL,
			media_type TEXT NOT NULL
		);

		CREATE UNIQUE INDEX IF NOT EXISTS conversation_attachment_blob_key_unique
			ON conversation_attachment (blob_key);

		CREATE TABLE IF NOT EXISTS conversation_session (
			id TEXT PRIMARY KEY NOT NULL,
			workspace_id TEXT REFERENCES conversation_workspace(id)
				ON UPDATE CASCADE ON DELETE SET NULL,
			title TEXT,
			pinned INTEGER DEFAULT 0 NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_message_at INTEGER,
			model_json TEXT,
			variant TEXT
		);

		CREATE INDEX IF NOT EXISTS idx_conversation_session_pinned_last_message
			ON conversation_session (pinned, last_message_at);
		CREATE INDEX IF NOT EXISTS idx_conversation_session_updated
			ON conversation_session (updated_at);

		CREATE TABLE IF NOT EXISTS conversation_compaction (
			id TEXT PRIMARY KEY NOT NULL,
			session_id TEXT NOT NULL REFERENCES conversation_session(id)
				ON UPDATE CASCADE ON DELETE CASCADE,
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

		CREATE INDEX IF NOT EXISTS idx_conversation_compaction_session_sequence
			ON conversation_compaction (session_id, sequence);
		CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_compaction_session_sequence
			ON conversation_compaction (session_id, sequence);

		CREATE TABLE IF NOT EXISTS prompt_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			prompt TEXT NOT NULL,
			entry_json TEXT,
			created_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS conversation_record (
			record_id TEXT PRIMARY KEY NOT NULL,
			session_id TEXT NOT NULL REFERENCES conversation_session(id)
				ON UPDATE CASCADE ON DELETE CASCADE,
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

		CREATE INDEX IF NOT EXISTS idx_conversation_record_session_position
			ON conversation_record (session_id, position);
		CREATE INDEX IF NOT EXISTS idx_conversation_record_session_turn
			ON conversation_record (session_id, turn_id);
		CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_record_session_position
			ON conversation_record (session_id, position);
	`);
};

export const createDatabase = (
	path: string = resolveLocalDatabasePath()
): { db: ConversationDatabase; sqlite: Database } => {
	const sqlite = new Database(path, { create: true });
	applyPragmas(sqlite);
	initializeSchema(sqlite);
	const db = drizzle(sqlite, { schema: conversationSchema });
	return { db, sqlite };
};
