import { createHash } from "node:crypto";
import {
	CONVERSATION_RECORD_VERSION,
	type ConversationRecord,
	isConversationAttachmentReferencePart,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	modelSelectionSchema,
} from "@wincode/ai/models";
import { and, asc, desc, eq } from "drizzle-orm";
import type {
	AppendConversationCompactionInput,
	ConversationCompaction,
} from "../compaction/types";
import type { ConversationMessage } from "../message";
import type {
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	ConversationAttachmentStore,
} from "./attachment-store";
import {
	createConversationAttachmentStore,
	createDrizzleAttachmentMetadataRepository,
	getAttachmentReference,
	isLegacyImagePart,
} from "./attachment-store";
import { type ConversationDatabase, createDatabase } from "./client";
import {
	ConversationRecordInvariantError,
	getConversationRecordValidationError,
	toDurableConversationMessageRecord,
} from "./conversation-record";
import {
	type CommitConversationRecordInput,
	type ConversationSession,
	type ConversationStore,
	type CreateSessionInput,
	type PromptHistoryEntry,
	UNTITLED_SESSION_TITLE,
	type UpdateSessionInput,
} from "./conversation-store";
import { runMigrations } from "./migrations";
import { resolveLocalAttachmentRoot } from "./path";
import {
	conversationCompaction,
	conversationRecord,
	conversationSession,
	conversationWorkspace,
	promptHistory,
} from "./schema";

const createId = (): string => crypto.randomUUID();

const writePromptHistory = (
	db: ConversationDatabase,
	entry: PromptHistoryEntry
): void => {
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
		JSON.stringify(latest.entry?.files ?? []) === JSON.stringify(entry.files) &&
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
					...(entry.pastedText ? { pastedText: entry.pastedText } : {}),
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
};

export const createPromptHistory = (
	db: ConversationDatabase,
	attachmentStore?: ConversationAttachmentStore
) => {
	const get = () =>
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
				...(row.entry?.pastedText ? { pastedText: row.entry.pastedText } : {}),
				files: row.entry?.files ?? [],
				text: row.text,
			}));

	const externalizeFiles = async (
		files: PromptHistoryEntry["files"]
	): Promise<PromptHistoryEntry["files"]> => {
		if (!attachmentStore || files.length === 0) {
			return files;
		}
		const [message] = await attachmentStore.externalizeMessages([
			{
				id: "prompt-history",
				parts: files,
				role: "user",
			} as ConversationMessage,
		]);
		return (message?.parts ?? []).filter(
			(part): part is PromptHistoryEntry["files"][number] =>
				part.type === "file"
		);
	};
	const migrateLegacyEntry = async (
		entry: PromptHistoryEntry
	): Promise<PromptHistoryEntry> => {
		if (!entry.files.some(isLegacyImagePart)) {
			return entry;
		}
		try {
			return { ...entry, files: await externalizeFiles(entry.files) };
		} catch {
			return entry;
		}
	};

	const migrate = async (): Promise<PromptHistoryEntry[]> => {
		if (!attachmentStore) {
			return get();
		}
		const rows = db
			.select({
				entry: promptHistory.entryJson,
				id: promptHistory.id,
				text: promptHistory.prompt,
			})
			.from(promptHistory)
			.orderBy(desc(promptHistory.id))
			.limit(50)
			.all();
		const migrated: Array<{
			entry: PromptHistoryEntry;
			id: number;
			changed: boolean;
		}> = [];
		for (const row of rows) {
			const original: PromptHistoryEntry = {
				...(row.entry?.fileTokens ? { fileTokens: row.entry.fileTokens } : {}),
				...(row.entry?.pastedText ? { pastedText: row.entry.pastedText } : {}),
				files: row.entry?.files ?? [],
				text: row.text,
			};
			const migratedEntry = await migrateLegacyEntry(original);
			migrated.push({
				changed:
					JSON.stringify(migratedEntry.files) !==
					JSON.stringify(original.files),
				entry: migratedEntry,
				id: row.id,
			});
		}
		const changes = migrated.filter(({ changed }) => changed);
		if (changes.length > 0) {
			db.transaction((tx) => {
				for (const { entry, id } of changes) {
					tx.update(promptHistory)
						.set({
							entryJson: {
								...(entry.fileTokens ? { fileTokens: entry.fileTokens } : {}),
								...(entry.pastedText ? { pastedText: entry.pastedText } : {}),
								files: entry.files,
							},
						})
						.where(eq(promptHistory.id, id))
						.run();
				}
			});
		}
		return migrated.map(({ entry }) => entry);
	};

	const record = (entry: PromptHistoryEntry): Promise<void> => {
		if (!attachmentStore) {
			writePromptHistory(db, entry);
			return Promise.resolve();
		}
		return (async () => {
			const files = await externalizeFiles(entry.files);
			writePromptHistory(db, { ...entry, files });
		})();
	};

	const clear = (): Promise<void> => {
		db.delete(promptHistory).run();
		return Promise.resolve();
	};

	return { clear, get, migrate, record };
};
type SessionRow = typeof conversationSession.$inferSelect;
type CompactionRow = typeof conversationCompaction.$inferSelect;
type ConversationRecordRow = typeof conversationRecord.$inferSelect;

const toConversationCompaction = (
	row: CompactionRow
): ConversationCompaction => ({
	completedAt: row.completedAt,
	createdAt: row.createdAt,
	firstKeptUiMessageId: row.firstKeptUiMessageId,
	firstKeptAssistantPartIndex: row.firstKeptAssistantPartIndex ?? undefined,
	focus: row.focus ?? undefined,
	id: row.id,
	priorCompactionId: row.priorCompactionId ?? undefined,
	sequence: row.sequence,
	summarizationVariant: row.summarizationVariant ?? undefined,
	sessionId: row.sessionId,
	summarizationModel: row.summarizationModelJson,
	summarizationUsage: row.summarizationUsageJson ?? undefined,
	summary: row.summaryJson,
	throughMessageUiId: row.throughMessageUiId,
	tokensAfter: row.tokensAfter,
	tokensBefore: row.tokensBefore,
	trigger: row.trigger,
});

export type DrizzleConversationStoreOptions = {
	attachmentRoot?: string;
	attachmentStore?: ConversationAttachmentStore;
	workspaceRoot?: string;
};

const hashWorkspace = (rootPath: string): string =>
	createHash("sha256").update(rootPath).digest("hex").slice(0, 16);

const ensureWorkspace = (db: ConversationDatabase, rootPath: string) => {
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

const deriveSessionTitle = (messages: ConversationMessage[]): string => {
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
	...(row.modelJson ? { model: row.modelJson } : {}),
	pinned: row.pinned,
	title: row.title ?? UNTITLED_SESSION_TITLE,
	...(row.variant ? { variant: row.variant } : {}),
});
const toConversationRecordModel = (
	model: Pick<ConversationRecord["model"], "modelId" | "providerId">,
	variant: ConversationRecord["model"]["variant"]
): ConversationRecord["model"] => ({
	modelId: model.modelId,
	providerId: model.providerId,
	...(variant === undefined ? {} : { variant }),
});
const toConversationRecord = (
	row: ConversationRecordRow
): ConversationRecord => ({
	agentId: row.agentId,
	...(row.delegationJson === null ? {} : { delegation: row.delegationJson }),
	id: row.recordId,
	messages: row.messagesJson,
	model: row.modelJson,
	outcome: row.outcomeJson as ConversationRecord["outcome"],
	turnId: row.turnId,
	version: row.version as ConversationRecord["version"],
});

const collectLiveAttachmentIds = (db: ConversationDatabase): Set<string> => {
	const live = new Set<string>();
	const recordRows = db
		.select({ messages: conversationRecord.messagesJson })
		.from(conversationRecord)
		.all();
	for (const row of recordRows) {
		for (const message of row.messages) {
			for (const part of message.parts) {
				if (isConversationAttachmentReferencePart(part)) {
					live.add(part.attachmentId);
				}
			}
		}
	}
	const historyRows = db
		.select({ entry: promptHistory.entryJson })
		.from(promptHistory)
		.all();
	for (const row of historyRows) {
		for (const file of row.entry?.files ?? []) {
			const reference = getAttachmentReference(file);
			if (reference) {
				live.add(reference.attachmentId);
			}
		}
	}
	return live;
};

const appendCompaction = (
	db: ConversationDatabase,
	workspaceId: string,
	input: AppendConversationCompactionInput
): ConversationCompaction =>
	db.transaction((tx) => {
		const session = tx
			.select({ id: conversationSession.id })
			.from(conversationSession)
			.where(
				and(
					eq(conversationSession.id, input.sessionId),
					eq(conversationSession.workspaceId, workspaceId)
				)
			)
			.get();
		if (!session) {
			throw new Error("Session not found");
		}

		const latest = tx
			.select({ sequence: conversationCompaction.sequence })
			.from(conversationCompaction)
			.where(eq(conversationCompaction.sessionId, input.sessionId))
			.orderBy(desc(conversationCompaction.sequence))
			.limit(1)
			.get();
		const sequence = (latest?.sequence ?? 0) + 1;
		const id = input.id ?? createId();
		const createdAt = input.createdAt ?? new Date();
		const completedAt = input.completedAt ?? createdAt;
		const row = {
			completedAt,
			createdAt,
			firstKeptAssistantPartIndex: input.firstKeptAssistantPartIndex ?? null,
			firstKeptUiMessageId: input.firstKeptUiMessageId,
			summarizationVariant: input.summarizationVariant ?? null,
			focus: input.focus ?? null,
			id,
			priorCompactionId: input.priorCompactionId ?? null,
			sequence,
			sessionId: input.sessionId,
			summarizationModelJson: input.summarizationModel,
			summarizationUsageJson: input.summarizationUsage ?? null,
			summaryJson: input.summary,
			throughMessageUiId: input.throughMessageUiId,
			tokensAfter: input.tokensAfter,
			tokensBefore: input.tokensBefore,
			trigger: input.trigger,
		};
		tx.insert(conversationCompaction).values(row).run();
		return toConversationCompaction(row);
	});

const writeConversationRecordCheckpoint = (
	db: ConversationDatabase,
	workspaceId: string,
	{
		conversationModel,
		conversationVariant,
		record,
		sessionId,
	}: CommitConversationRecordInput
): void => {
	const validationError = getConversationRecordValidationError(record);
	if (validationError !== null) {
		throw new ConversationRecordInvariantError(
			`Invalid Conversation Record: ${validationError}`,
			{ cause: new Error(validationError) }
		);
	}
	const modelJson = toConversationRecordModel(
		record.model,
		record.model.variant
	);
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

		const latest = tx
			.select({ position: conversationRecord.position })
			.from(conversationRecord)
			.where(eq(conversationRecord.sessionId, sessionId))
			.orderBy(desc(conversationRecord.position))
			.limit(1)
			.get();
		const now = new Date();
		tx.insert(conversationRecord)
			.values({
				agentId: record.agentId,
				createdAt: now,
				delegationJson: record.delegation ?? null,
				messagesJson: [...record.messages],
				modelJson,
				outcomeJson: record.outcome,
				position: (latest?.position ?? -1) + 1,
				recordId: record.id,
				sessionId,
				turnId: record.turnId,
				version: record.version,
			})
			.run();

		tx.update(conversationSession)
			.set({
				lastMessageAt: now,
				...(conversationModel === undefined
					? {}
					: {
							modelJson: conversationModel,
							variant: conversationVariant ?? null,
						}),
				updatedAt: now,
			})
			.where(
				and(
					eq(conversationSession.id, sessionId),
					eq(conversationSession.workspaceId, workspaceId)
				)
			)
			.run();
	});
};

const readConversationRecordRows = (
	db: ConversationDatabase,
	workspaceId: string,
	sessionId: string
): ConversationRecordRow[] =>
	db
		.select({ record: conversationRecord })
		.from(conversationRecord)
		.innerJoin(
			conversationSession,
			eq(conversationRecord.sessionId, conversationSession.id)
		)
		.where(
			and(
				eq(conversationRecord.sessionId, sessionId),
				eq(conversationSession.workspaceId, workspaceId)
			)
		)
		.orderBy(asc(conversationRecord.position))
		.all()
		.map(({ record }) => record);

const readConversationRecords = (
	db: ConversationDatabase,
	workspaceId: string,
	sessionId: string
): ConversationRecord[] =>
	readConversationRecordRows(db, workspaceId, sessionId).map(
		toConversationRecord
	);

export const createDrizzleConversationStore = (
	database?: ConversationDatabase,
	options: DrizzleConversationStoreOptions = {}
): ConversationStore => {
	const db = database ?? createDatabase().db;

	if (!database) {
		runMigrations(db);
	}
	const attachmentStore =
		options.attachmentStore ??
		createConversationAttachmentStore({
			repository: createDrizzleAttachmentMetadataRepository(db),
			root: options.attachmentRoot ?? resolveLocalAttachmentRoot(),
		});
	const externalizeAttachments = (
		messages: readonly ConversationMessage[],
		signal?: AbortSignal,
		externalizationOptions?: AttachmentExternalizationOptions
	): Promise<ConversationMessage[]> =>
		attachmentStore
			? attachmentStore.externalizeMessages(
					messages,
					signal,
					externalizationOptions
				)
			: Promise.resolve([...messages]);
	const hydrateAttachments = (
		messages: readonly ConversationMessage[],
		hydrationOptions: AttachmentHydrationOptions
	): Promise<ConversationMessage[]> =>
		attachmentStore
			? attachmentStore.hydrateMessages(messages, hydrationOptions)
			: Promise.resolve([...messages]);
	const promptHistoryStore = createPromptHistory(db, attachmentStore);
	const workspace = ensureWorkspace(db, options.workspaceRoot ?? process.cwd());
	const collectAttachments = (
		safetyWindowMs = 60_000
	): Promise<AttachmentMaintenanceReport> =>
		attachmentStore
			? attachmentStore.collect({
					liveAttachmentIds: collectLiveAttachmentIds(db),
					safetyWindowMs,
				})
			: Promise.resolve({
					orphanBytes: 0,
					orphanCount: 0,
					reclaimedBytes: 0,
					reclaimedCount: 0,
				});

	return {
		appendCompaction: (input) =>
			Promise.resolve(appendCompaction(db, workspace.id, input)),
		getPromptHistory: () => promptHistoryStore.migrate(),
		recordPrompt: async (entry) => {
			await promptHistoryStore.record(entry);
			await collectAttachments().catch(() => undefined);
		},
		clearPromptHistory: async () => {
			await promptHistoryStore.clear();
			await collectAttachments().catch(() => undefined);
		},
		createSession: async ({
			agent,
			message,
			model,
			turnId,
			variant,
		}: CreateSessionInput) => {
			const durableMessage = toDurableConversationMessageRecord(message);
			if (durableMessage === undefined || durableMessage.role !== "user") {
				throw new Error("Initial conversation message has no durable parts.");
			}
			const id = createId();
			const now = new Date();
			const recordModel = toConversationRecordModel(
				message.metadata?.model ?? model,
				message.metadata?.variant ?? variant
			);

			db.transaction((tx) => {
				tx.insert(conversationSession)
					.values({
						createdAt: now,
						id,
						lastMessageAt: now,
						modelJson: model,
						pinned: false,
						title: deriveSessionTitle([message]),
						updatedAt: now,
						variant,
						workspaceId: workspace.id,
					})
					.run();
				tx.insert(conversationRecord)
					.values({
						agentId: agent,
						createdAt: now,
						delegationJson: null,
						messagesJson: [durableMessage],
						modelJson: recordModel,
						outcomeJson: { kind: "user" },
						position: 0,
						recordId: createId(),
						sessionId: id,
						turnId,
						version: CONVERSATION_RECORD_VERSION,
					})
					.run();
			});

			return { id };
		},

		deleteSession: async (sessionId: string) => {
			db.delete(conversationSession)
				.where(
					and(
						eq(conversationSession.id, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.run();
			await collectAttachments().catch(() => undefined);
		},

		getCompactions: (sessionId: string) => {
			const rows = db
				.select({
					compaction: conversationCompaction,
				})
				.from(conversationCompaction)
				.innerJoin(
					conversationSession,
					eq(conversationCompaction.sessionId, conversationSession.id)
				)
				.where(
					and(
						eq(conversationCompaction.sessionId, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.orderBy(asc(conversationCompaction.sequence))
				.all();
			return Promise.resolve(
				rows.map(({ compaction }) => toConversationCompaction(compaction))
			);
		},

		getLatestCompaction: (sessionId: string) => {
			const row = db
				.select({
					compaction: conversationCompaction,
				})
				.from(conversationCompaction)
				.innerJoin(
					conversationSession,
					eq(conversationCompaction.sessionId, conversationSession.id)
				)
				.where(
					and(
						eq(conversationCompaction.sessionId, sessionId),
						eq(conversationSession.workspaceId, workspace.id)
					)
				)
				.orderBy(desc(conversationCompaction.sequence))
				.limit(1)
				.get();
			return Promise.resolve(
				row ? toConversationCompaction(row.compaction) : null
			);
		},

		commitConversationRecord: async ({
			conversationModel,
			conversationVariant,
			record,
			sessionId,
		}) => {
			writeConversationRecordCheckpoint(db, workspace.id, {
				conversationModel,
				conversationVariant,
				record,
				sessionId,
			});
		},
		listConversationRecords: async (sessionId: string) =>
			readConversationRecords(db, workspace.id, sessionId),
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
				.select({
					createdAt: conversationRecord.createdAt,
					model: conversationRecord.modelJson,
				})
				.from(conversationRecord)
				.innerJoin(
					conversationSession,
					eq(conversationRecord.sessionId, conversationSession.id)
				)
				.where(eq(conversationSession.workspaceId, workspace.id))
				.orderBy(desc(conversationRecord.createdAt))
				.limit(Math.max(limit * 8, limit))
				.all();
			const result: ChatModelSelection[] = [];
			const seen = new Set<string>();
			for (const row of rows) {
				const parsed = modelSelectionSchema.safeParse({
					modelId: row.model.modelId,
					providerId: row.model.providerId,
				});
				if (!parsed.success) {
					continue;
				}
				const key = `${parsed.data.providerId}:${parsed.data.modelId}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				result.push(parsed.data);
				if (result.length === limit) {
					break;
				}
			}
			return result;
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
		attachmentStore,
		externalizeAttachments,
		hydrateAttachments,
		collectAttachments,
	};
};
