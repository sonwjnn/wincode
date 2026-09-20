import type { SessionMessageRecord, SessionRecord } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { EditMode, FileVersion } from "@wincode/coding-tools";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import type { Jsonify } from "type-fest";
import type { SessionCompaction } from "../compaction/types";
import type {
	PromptHistoryEntry,
	SessionRecordStorageOutcome,
} from "./session-store";
export type SerializedJson<T> = Jsonify<T>;

export const sessionWorkspace = sqliteTable("session_workspace", {
	id: text("id").primaryKey(),
	rootPath: text("root_path").notNull().unique(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessionAttachment = sqliteTable("session_attachment", {
	attachmentId: text("attachment_id").primaryKey(),
	blobKey: text("blob_key").notNull().unique(),
	byteLength: integer("byte_length").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	integrityVersion: integer("integrity_version").notNull().default(1),
	mediaType: text("media_type").notNull(),
});

export const session = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id").references(() => sessionWorkspace.id, {
			onDelete: "set null",
			onUpdate: "cascade",
		}),
		title: text("title"),
		pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
		lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
		modelJson: text("model_json", { mode: "json" }).$type<
			SerializedJson<ChatModelSelection>
		>(),
		variant: text("variant").$type<ModelVariant>(),
		editMode: text("edit_mode").$type<EditMode>().notNull().default("hashline"),
	},
	(table) => [
		index("idx_session_pinned_last_message").on(
			table.pinned,
			table.lastMessageAt
		),
		index("idx_session_updated").on(table.updatedAt),
	]
);
export const fileSnapshot = sqliteTable(
	"file_snapshot",
	{
		path: text("path").notNull(),
		fileVersion: text("file_version").$type<FileVersion>().notNull(),
		algorithm: text("algorithm").notNull(),
		blobKey: text("blob_key").notNull(),
		lineCount: integer("line_count").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		unique("uq_file_snapshot_path_version").on(table.path, table.fileVersion),
		index("idx_file_snapshot_path_created").on(table.path, table.createdAt),
	]
);

export const fileObservation = sqliteTable(
	"file_observation",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => session.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		path: text("path").notNull(),
		fileVersion: text("file_version").$type<FileVersion>().notNull(),
		seenLinesJson: text("seen_lines_json").notNull(),
		snapshotAvailable: integer("snapshot_available", { mode: "boolean" })
			.notNull()
			.default(false),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("idx_file_observation_session_path_created").on(
			table.sessionId,
			table.path,
			table.createdAt
		),
		unique("uq_file_observation_session_path_version").on(
			table.sessionId,
			table.path,
			table.fileVersion
		),
	]
);

export const sessionCompaction = sqliteTable(
	"session_compaction",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => session.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		sequence: integer("sequence").notNull(),
		priorCompactionId: text("prior_compaction_id"),
		summaryJson: text("summary_json", { mode: "json" })
			.$type<SerializedJson<SessionCompaction["summary"]>>()
			.notNull(),
		firstKeptUiMessageId: text("first_kept_ui_message_id").notNull(),
		firstKeptAssistantPartIndex: integer("first_kept_assistant_part_index"),
		throughMessageUiId: text("through_message_ui_id").notNull(),
		tokensBefore: integer("tokens_before").notNull(),
		estimatedTokensAfter: integer("estimated_tokens_after").notNull(),
		trigger: text("trigger").$type<SessionCompaction["trigger"]>().notNull(),
		focus: text("focus"),
		summarizationModelJson: text("summarization_model_json", { mode: "json" })
			.$type<SerializedJson<SessionCompaction["summarizationModel"]>>()
			.notNull(),
		summarizationVariant: text("summarization_variant").$type<ModelVariant>(),
		summarizationUsageJson: text("summarization_usage_json", {
			mode: "json",
		}).$type<SerializedJson<SessionCompaction["summarizationUsage"]>>(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		unique("uq_session_compaction_session_sequence").on(
			table.sessionId,
			table.sequence
		),
		index("idx_session_compaction_session_sequence").on(
			table.sessionId,
			table.sequence
		),
	]
);

export const promptHistory = sqliteTable("prompt_history", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	prompt: text("prompt").notNull(),
	entryJson: text("entry_json", { mode: "json" }).$type<
		SerializedJson<
			Pick<PromptHistoryEntry, "files" | "fileTokens" | "pastedText">
		>
	>(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One durable Wincode Session Record checkpoint: one committed user,
 * assistant, or completed Tool Call message plus its semantic outcome. Token
 * and reasoning deltas never become rows here. Rows are scoped to a session;
 * `position` keeps checkpoints in commit order per session.
 *
 * TODO(issue-86): add richer durable interrupted metadata only when the
 * product has a defined resume/retry contract. A retrying turn is intentionally
 * not persisted, and neither is a Queued Submission: it lives in the Session
 * Engine until it starts running (ADR-0021), so a restart never replays one.
 */
export const sessionRecord = sqliteTable(
	"session_record",
	{
		recordId: text("record_id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => session.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		turnId: text("turn_id").notNull(),
		agentId: text("agent_id").notNull(),
		delegationJson: text("delegation_json", { mode: "json" }).$type<
			SerializedJson<{
				parentTurnId: string;
				parentToolCallId: string;
			} | null>
		>(),
		modelJson: text("model_json", { mode: "json" })
			.$type<SerializedJson<SessionRecord["model"]>>()
			.notNull(),
		outcomeJson: text("outcome_json", { mode: "json" })
			.$type<SerializedJson<SessionRecordStorageOutcome>>()
			.notNull(),
		messagesJson: text("messages_json", { mode: "json" })
			.$type<SerializedJson<SessionMessageRecord[]>>()
			.notNull(),
		version: integer("version").notNull(),
		position: integer("position").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		unique("uq_session_record_session_position").on(
			table.sessionId,
			table.position
		),
		index("idx_session_record_session_position").on(
			table.sessionId,
			table.position
		),
		index("idx_session_record_session_turn").on(table.sessionId, table.turnId),
	]
);
export const sessionSchema = {
	fileObservation,
	fileSnapshot,
	sessionAttachment,
	sessionCompaction,
	sessionRecord,
	session,
	sessionWorkspace,
	promptHistory,
};
