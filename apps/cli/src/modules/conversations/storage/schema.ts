import type {
	AgentTurnOutcomeRecord,
	ConversationMessageRecord,
} from "@wincode/agent-core";
import type { AgentId, CodingAgentUIMessage } from "@wincode/ai";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import type { ConversationCompaction } from "../compaction/types";
import type { PromptHistoryEntry } from "./conversation-store";

export const conversationWorkspace = sqliteTable("conversation_workspace", {
	id: text("id").primaryKey(),
	rootPath: text("root_path").notNull().unique(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const conversationAttachment = sqliteTable("conversation_attachment", {
	attachmentId: text("attachment_id").primaryKey(),
	blobKey: text("blob_key").notNull().unique(),
	byteLength: integer("byte_length").notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	integrityVersion: integer("integrity_version").notNull().default(1),
	mediaType: text("media_type").notNull(),
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
		modelJson: text("model_json", { mode: "json" }).$type<ChatModelSelection>(),
		variant: text("variant").$type<ModelVariant>(),
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
		agent: text("agent").$type<AgentId>().notNull(),
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

export const conversationCompaction = sqliteTable(
	"conversation_compaction",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => conversationSession.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		sequence: integer("sequence").notNull(),
		priorCompactionId: text("prior_compaction_id"),
		summaryJson: text("summary_json", { mode: "json" })
			.$type<ConversationCompaction["summary"]>()
			.notNull(),
		firstKeptUiMessageId: text("first_kept_ui_message_id").notNull(),
		firstKeptAssistantPartIndex: integer("first_kept_assistant_part_index"),
		throughMessageUiId: text("through_message_ui_id").notNull(),
		tokensBefore: integer("tokens_before").notNull(),
		tokensAfter: integer("tokens_after").notNull(),
		trigger: text("trigger")
			.$type<ConversationCompaction["trigger"]>()
			.notNull(),
		focus: text("focus"),
		summarizationModelJson: text("summarization_model_json", { mode: "json" })
			.$type<ConversationCompaction["summarizationModel"]>()
			.notNull(),
		summarizationVariant: text("summarization_variant").$type<ModelVariant>(),
		summarizationUsageJson: text("summarization_usage_json", {
			mode: "json",
		}).$type<ConversationCompaction["summarizationUsage"]>(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		unique("uq_conversation_compaction_session_sequence").on(
			table.sessionId,
			table.sequence
		),
		index("idx_conversation_compaction_session_sequence").on(
			table.sessionId,
			table.sequence
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

/**
 * One durable Wincode Conversation Record checkpoint: the committed message
 * records, model, usage/terminal outcome, and Agent Turn identity of one
 * semantic checkpoint. Token and reasoning deltas never become rows here.
 * Rows are scoped to a legacy session for presentation continuity; `position`
 * keeps checkpoints in commit order per session.
 */
export const conversationRecord = sqliteTable(
	"conversation_record",
	{
		recordId: text("record_id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => conversationSession.id, {
				onDelete: "cascade",
				onUpdate: "cascade",
			}),
		turnId: text("turn_id").notNull(),
		agentId: text("agent_id").notNull(),
		delegationJson: text("delegation_json", { mode: "json" }).$type<{
			parentTurnId: string;
			parentToolCallId: string;
		} | null>(),
		modelJson: text("model_json", { mode: "json" })
			.$type<{ modelId: string; providerId: string }>()
			.notNull(),
		outcomeJson: text("outcome_json", { mode: "json" })
			.$type<AgentTurnOutcomeRecord>()
			.notNull(),
		messagesJson: text("messages_json", { mode: "json" })
			.$type<ConversationMessageRecord[]>()
			.notNull(),
		version: integer("version").notNull(),
		position: integer("position").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		unique("uq_conversation_record_session_position").on(
			table.sessionId,
			table.position
		),
		index("idx_conversation_record_session_position").on(
			table.sessionId,
			table.position
		),
		index("idx_conversation_record_session_turn").on(
			table.sessionId,
			table.turnId
		),
	]
);
export const conversationSchema = {
	conversationAttachment,
	conversationCompaction,
	conversationMessage,
	conversationRecord,
	conversationSession,
	conversationWorkspace,
	promptHistory,
};

export const CURRENT_USER_VERSION = 3;

export const setUserVersion = sql`PRAGMA user_version = ${sql.raw(
	String(CURRENT_USER_VERSION)
)}`;
