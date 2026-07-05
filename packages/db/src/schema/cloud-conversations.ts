import type { CodingAgentUIMessage, CodingMessageMetadata } from "@wincode/ai";
import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

// Mirrors the Prisma-managed chat_session / chat_message tables and the
// ChatMessageRole enum. Column names are camelCase to match Prisma field names.

export const chatMessageRole = pgEnum("ChatMessageRole", [
	"system",
	"user",
	"assistant",
]);

export const chatSession = pgTable(
	"chat_session",
	{
		id: text("id").primaryKey(),
		title: text("title"),
		pinned: boolean("pinned").notNull().default(false),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
		lastMessageAt: timestamp("lastMessageAt", { mode: "date", precision: 3 }),
	},
	(table) => [
		index().on(table.pinned, table.lastMessageAt),
		index().on(table.updatedAt),
	]
);

export const chatMessage = pgTable(
	"chat_message",
	{
		id: text("id").primaryKey(),
		sessionId: text("sessionId")
			.notNull()
			.references(() => chatSession.id, { onDelete: "cascade" }),
		uiMessageId: text("uiMessageId").notNull(),
		role: chatMessageRole("role").notNull(),
		mode: text("mode").notNull(),
		parts: jsonb("parts").$type<CodingAgentUIMessage["parts"]>().notNull(),
		metadata: jsonb("metadata").$type<CodingMessageMetadata>(),
		position: integer("position").notNull(),
		createdAt: timestamp("createdAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updatedAt", { mode: "date", precision: 3 })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		unique().on(table.sessionId, table.uiMessageId),
		index().on(table.sessionId, table.position),
		index().on(table.sessionId, table.createdAt),
	]
);

export const chatSessionRelations = relations(chatSession, ({ many }) => ({
	messages: many(chatMessage),
}));

export const chatMessageRelations = relations(chatMessage, ({ one }) => ({
	session: one(chatSession, {
		fields: [chatMessage.sessionId],
		references: [chatSession.id],
	}),
}));
