import type { CodingAgentUIMessage, ModeType } from "@wincode/ai";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import type { PromptHistoryEntry } from "./conversation-store";

export const conversationWorkspace = sqliteTable("conversation_workspace", {
	id: text("id").primaryKey(),
	rootPath: text("root_path").notNull().unique(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const conversationSession = sqliteTable(
	"conversation_session",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id").references(
			() => conversationWorkspace.id,
			{ onDelete: "set null", onUpdate: "cascade" }
		),
		title: text("title"),
		pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
		lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		index("idx_conversation_session_pinned_last_message").on(
			table.pinned,
			table.lastMessageAt
		),
		index("idx_conversation_session_updated").on(table.updatedAt),
	]
);

export const conversationMessage = sqliteTable(
	"conversation_message",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => conversationSession.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		uiMessageId: text("ui_message_id").notNull(),
		role: text("role").$type<CodingAgentUIMessage["role"]>().notNull(),
		mode: text("mode").$type<ModeType>().notNull(),
		partsJson: text("parts_json", { mode: "json" })
			.$type<CodingAgentUIMessage["parts"]>()
			.notNull(),
		metadataJson: text("metadata_json", { mode: "json" }).$type<
			CodingAgentUIMessage["metadata"]
		>(),
		position: integer("position").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		unique("uq_conversation_message_session_ui").on(
			table.sessionId,
			table.uiMessageId
		),
		index("idx_conversation_message_session_position").on(
			table.sessionId,
			table.position
		),
		index("idx_conversation_message_session_created").on(
			table.sessionId,
			table.createdAt
		),
	]
);

export const promptHistory = sqliteTable("prompt_history", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	prompt: text("prompt").notNull(),
	entryJson: text("entry_json", { mode: "json" }).$type<
		Pick<PromptHistoryEntry, "files" | "fileTokens" | "pastedText">
	>(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const localConversationSchema = {
	conversationMessage,
	conversationSession,
	conversationWorkspace,
	promptHistory,
};

export const CURRENT_USER_VERSION = 1;

export const setUserVersion = sql`PRAGMA user_version = ${sql.raw(
	String(CURRENT_USER_VERSION)
)}`;
