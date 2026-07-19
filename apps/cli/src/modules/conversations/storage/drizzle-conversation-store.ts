import { createHash } from "node:crypto";
import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	codingMessageMetadataSchema,
	type ModeType,
} from "@wincode/ai";
import { generateId, safeValidateUIMessages } from "ai";
import { and, asc, desc, eq } from "drizzle-orm";
import { createLocalDatabase, type LocalConversationDatabase } from "./client";
import {
	type ConversationSession,
	type ConversationStore,
	type CreateSessionInput,
	type PersistMessagesInput,
	type PromptHistoryEntry,
	UNTITLED_SESSION_TITLE,
	type UpdateSessionInput,
} from "./conversation-store";
import { runLocalMigrations } from "./migrations";
import {
	conversationMessage,
	conversationSession,
	conversationWorkspace,
	promptHistory,
} from "./schema";

export const createPromptHistory = (db: LocalConversationDatabase) => ({
	get: () =>
		db
			.select({
				entry: promptHistory.entryJson,
				text: promptHistory.prompt,
			})
			.from(promptHistory)
			.orderBy(desc(promptHistory.id))
			.limit(50)
			.all()
			.map((row) => ({
				...(row.entry?.fileTokens ? { fileTokens: row.entry.fileTokens } : {}),
				files: row.entry?.files ?? [],
				text: row.text,
			})),
	record: (entry: PromptHistoryEntry) => {
		if (!entry.text.trim()) {
			return;
		}
		const latest = db
			.select({
				entry: promptHistory.entryJson,
				text: promptHistory.prompt,
			})
			.from(promptHistory)
			.orderBy(desc(promptHistory.id))
			.limit(1)
			.get();
		if (
			latest?.text === entry.text &&
			JSON.stringify(latest.entry?.files ?? []) ===
				JSON.stringify(entry.files) &&
			JSON.stringify(latest.entry?.fileTokens ?? []) ===
				JSON.stringify(entry.fileTokens ?? [])
		) {
			return;
		}
		db.transaction((tx) => {
			tx.insert(promptHistory)
				.values({
					createdAt: new Date(),
					entryJson: {
						...(entry.fileTokens ? { fileTokens: entry.fileTokens } : {}),
						files: entry.files,
					},
					prompt: entry.text,
				})
				.run();
			const rows = tx
				.select({ id: promptHistory.id })
				.from(promptHistory)
				.orderBy(desc(promptHistory.id))
				.all();
			for (const row of rows.slice(50)) {
				tx.delete(promptHistory).where(eq(promptHistory.id, row.id)).run();
			}
		});
	},
});

type SessionRow = typeof conversationSession.$inferSelect;

type DrizzleConversationStoreOptions = {
	workspaceRoot?: string;
};

const hashWorkspace = (rootPath: string): string =>
	createHash("sha256").update(rootPath).digest("hex").slice(0, 16);

const ensureWorkspace = (db: LocalConversationDatabase, rootPath: string) => {
	const now = new Date();
	const workspace = {
		createdAt: now,
		id: hashWorkspace(rootPath),
		rootPath,
		updatedAt: now,
	};

	db.insert(conversationWorkspace)
		.values(workspace)
		.onConflictDoUpdate({
			set: { rootPath, updatedAt: now },
			target: conversationWorkspace.id,
		})
		.run();

	return workspace;
};

const deriveSessionTitle = (messages: CodingAgentUIMessage[]): string => {
	for (const message of messages) {
		if (message.role !== "user" || !Array.isArray(message.parts)) {
			continue;
		}

		for (const part of message.parts) {
			if (part.type === "text" && part.text.trim()) {
				return part.text.trim();
			}
		}
	}

	return UNTITLED_SESSION_TITLE;
};

const toConversationSession = (row: SessionRow): ConversationSession => ({
	createdAt: row.createdAt,
	id: row.id,
	lastMessageAt: row.lastMessageAt ?? null,
	pinned: row.pinned,
	title: row.title ?? UNTITLED_SESSION_TITLE,
});

const resolveMode = (
	message: CodingAgentUIMessage,
	fallback: ModeType
): ModeType => message.metadata?.mode ?? fallback;

const resolveMetadata = (
	message: CodingAgentUIMessage,
	mode: ModeType,
	model: ChatModelSelection
): CodingAgentUIMessage["metadata"] => ({
	...(message.metadata ?? {}),
	mode: message.metadata?.mode ?? mode,
	model: message.metadata?.model ?? model,
});

const writeMessages = (
	db: LocalConversationDatabase,
	workspaceId: string,
	{ messages, mode, model, sessionId }: PersistMessagesInput
): void => {
	const now = new Date();
	const title = deriveSessionTitle(messages);

	db.transaction((tx) => {
		const session = tx
			.select({ id: conversationSession.id })
			.from(conversationSession)
			.where(
				and(
					eq(conversationSession.id, sessionId),
					eq(conversationSession.workspaceId, workspaceId)
				)
			)
			.get();

		if (!session) {
			throw new Error("Session not found");
		}

		tx.update(conversationSession)
			.set({ lastMessageAt: now, title, updatedAt: now })
			.where(
				and(
					eq(conversationSession.id, sessionId),
					eq(conversationSession.workspaceId, workspaceId)
				)
			)
			.run();

		messages.forEach((message, position) => {
			const values = {
				createdAt: now,
				id: generateId(),
				metadataJson: codingMessageMetadataSchema.parse(
					resolveMetadata(message, mode, model)
				),
				mode: resolveMode(message, mode),
				partsJson: message.parts,
				position,
				role: message.role,
				sessionId,
				uiMessageId: message.id,
				updatedAt: now,
			};

			tx.insert(conversationMessage)
				.values(values)
				.onConflictDoUpdate({
					set: {
						metadataJson: values.metadataJson,
						mode: values.mode,
						partsJson: values.partsJson,
						position: values.position,
						role: values.role,
						updatedAt: values.updatedAt,
					},
					target: [
						conversationMessage.sessionId,
						conversationMessage.uiMessageId,
					],
				})
				.run();
		});
	});
};

export const createDrizzleConversationStore = (
	database?: LocalConversationDatabase,
	options: DrizzleConversationStoreOptions = {}
): ConversationStore => {
	const db = database ?? createLocalDatabase().db;

	if (!database) {
		runLocalMigrations(db);
	}
	const promptHistoryStore = createPromptHistory(db);
	const workspace = ensureWorkspace(db, options.workspaceRoot ?? process.cwd());

	return {
		getPromptHistory: promptHistoryStore.get,
		recordPrompt: promptHistoryStore.record,
		createSession: ({ message, mode, model }: CreateSessionInput) => {
			const id = generateId();
			const now = new Date();

			db.insert(conversationSession)
				.values({
					createdAt: now,
					id,
					lastMessageAt: now,
					pinned: false,
					title: deriveSessionTitle([message]),
					updatedAt: now,
					workspaceId: workspace.id,
				})
				.run();

			writeMessages(db, workspace.id, {
				messages: [message],
				mode,
				model,
				sessionId: id,
			});

			return Promise.resolve({ id });
		},

		deleteSession: (sessionId: string) => {
			db.delete(conversationSession)
				.where(
					and(
						eq(conversationSession.id, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.run();
			return Promise.resolve();
		},

		getMessages: async (sessionId: string) => {
			const rows = db
				.select({
					metadataJson: conversationMessage.metadataJson,
					partsJson: conversationMessage.partsJson,
					role: conversationMessage.role,
					uiMessageId: conversationMessage.uiMessageId,
				})
				.from(conversationMessage)
				.innerJoin(
					conversationSession,
					eq(conversationMessage.sessionId, conversationSession.id)
				)
				.where(
					and(
						eq(conversationMessage.sessionId, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.orderBy(asc(conversationMessage.position))
				.all();

			if (rows.length === 0) {
				return [];
			}

			const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
				messages: rows.map((row) => ({
					id: row.uiMessageId,
					metadata:
						row.metadataJson === null || row.metadataJson === undefined
							? undefined
							: codingMessageMetadataSchema.parse(row.metadataJson),
					parts: row.partsJson,
					role: row.role,
				})),
			});

			if (!validation.success) {
				throw new Error("Invalid persisted chat messages.");
			}

			return validation.data;
		},

		getSession: (sessionId: string) => {
			const row = db
				.select()
				.from(conversationSession)
				.where(
					and(
						eq(conversationSession.id, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.get();

			if (!row) {
				return Promise.reject(new Error("Session not found"));
			}

			return Promise.resolve(toConversationSession(row));
		},

		listSessions: () => {
			const rows = db
				.select()
				.from(conversationSession)
				.where(eq(conversationSession.workspaceId, workspace.id))
				.orderBy(
					desc(conversationSession.pinned),
					desc(conversationSession.lastMessageAt),
					desc(conversationSession.createdAt)
				)
				.all();

			return Promise.resolve(rows.map(toConversationSession));
		},

		listRecentModelSelections: (limit: number) => {
			if (limit <= 0) {
				return [];
			}
			const rows = db
				.select({ metadata: conversationMessage.metadataJson })
				.from(conversationMessage)
				.innerJoin(
					conversationSession,
					eq(conversationMessage.sessionId, conversationSession.id)
				)
				.where(eq(conversationSession.workspaceId, workspace.id))
				.orderBy(desc(conversationMessage.createdAt))
				.limit(Math.max(limit * 8, limit))
				.all();
			const result: ChatModelSelection[] = [];
			const seen = new Set<string>();
			for (const row of rows) {
				const model = row.metadata
					? codingMessageMetadataSchema.parse(row.metadata).model
					: undefined;
				if (!model) {
					continue;
				}
				const key = `${model.providerId}:${model.modelId}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				result.push(model);
				if (result.length === limit) {
					break;
				}
			}
			return result;
		},

		persistMessages: (input: PersistMessagesInput) => {
			writeMessages(db, workspace.id, input);
			return Promise.resolve();
		},

		updateSession: (sessionId: string, data: UpdateSessionInput) => {
			db.update(conversationSession)
				.set({
					updatedAt: new Date(),
					...(data.title === undefined ? {} : { title: data.title }),
					...(data.pinned === undefined ? {} : { pinned: data.pinned }),
				})
				.where(
					and(
						eq(conversationSession.id, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.run();

			return Promise.resolve();
		},
	};
};
