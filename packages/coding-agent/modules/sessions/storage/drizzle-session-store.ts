import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	agentIdSchema,
	isSessionAttachmentReferencePart,
	SESSION_RECORD_VERSION,
	type SessionRecord,
	type SessionRecordId,
	toAgentTurnId,
	toSessionMessageId,
	toSessionRecordId,
} from "@wincode/agent-core";
import { modelUsageSchema } from "@wincode/ai";
import {
	isArray,
	isNull,
	isUndefined,
	omitUndefined,
	pickTruthy,
} from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
	normalizeProviderModelSelection,
	type ProviderModelSelection,
	providerModelSelectionSchema,
} from "@/modules/providers/provider-model-selection";
import type { EditMode } from "@/modules/tools";
import {
	type CompactionId,
	type SessionId,
	toCompactionId,
	toSessionId,
	toSessionUsageEntryId,
	toWorkspaceId,
	type WorkspaceId,
} from "@/shared/identifiers";
import {
	attachmentIdSchema,
	attachmentReferenceSchema,
} from "../attachment-reference";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import { type SessionMessage, withSubmissionStatus } from "../message";
import { restorePastedTextMarkers } from "../pasted-text";
import type {
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	SessionAttachmentStore,
} from "./attachment-store";
import {
	createDrizzleAttachmentMetadataRepository,
	createSessionAttachmentStore,
	getAttachmentReference,
	isLegacyImagePart,
} from "./attachment-store";
import { createDatabase, type SessionDatabase } from "./client";
import {
	resolveLocalAttachmentRoot,
	resolveLocalSessionLogRoot,
	resolveLocalSnapshotRoot,
} from "./path";
import {
	localSessionBinding,
	promptHistory,
	type SerializedJson,
	session,
	sessionAttachment,
	sessionCompaction,
	sessionProjectionCursor,
	sessionRecord,
	sessionUsageEntry,
	sessionWorkspace,
} from "./schema";
import type { SessionJsonlProjection } from "./session-jsonl-codec";
import { createSessionJsonlProjection } from "./session-jsonl-projection";
import {
	getSessionRecordValidationError,
	SessionRecordInvariantError,
	toDurableSessionMessageRecord,
} from "./session-record";
import {
	type CommitSessionRecordInput,
	type CreateSessionInput,
	type CreateSessionUsageEntryInput,
	type PromptHistoryEntry,
	type Session,
	type SessionProjectionStore,
	type SessionUsageEntry,
	UNTITLED_SESSION_TITLE,
	type UpdateSessionInput,
	type UpdateSessionSubmissionInput,
} from "./session-store";
import { acquireSessionWriterLock } from "./session-writer-lock";
import { createDrizzleFileObservationStore } from "./versioned-editing-store";

const createSessionId = (): SessionId => toSessionId(randomUUIDv7());
const createCompactionId = (): CompactionId => toCompactionId(randomUUIDv7());
const createSessionRecordId = (): SessionRecordId =>
	toSessionRecordId(randomUUIDv7());
const serializeJson = <T>(value: T): SerializedJson<T> =>
	value as SerializedJson<T>;
const promptHistoryFileSchema = z
	.object({
		available: z.boolean().optional(),
		attachmentId: attachmentIdSchema.optional(),
		blobKey: z.string().optional(),
		byteLength: z.number().int().nonnegative().optional(),
		displayAvailability: z.literal("missing").optional(),
		filename: z.string().optional(),
		mediaType: z.string(),
		type: z.literal("file"),
		url: z.string(),
	})
	.passthrough();

const promptHistoryEntrySchema = z.object({
	fileTokens: z
		.array(z.object({ start: z.number(), token: z.string() }))
		.optional(),
	files: z.array(promptHistoryFileSchema),
	pastedText: z
		.array(
			z.object({
				start: z.number().optional(),
				text: z.string(),
				token: z.string(),
			})
		)
		.optional(),
});

const parsePromptHistoryEntry = (
	entry: unknown,
	text: string
): PromptHistoryEntry => {
	const { pastedText, ...parsed } = promptHistoryEntrySchema.parse(
		entry ?? { files: [] }
	);
	return {
		...parsed,
		...(pastedText === undefined
			? {}
			: { pastedText: restorePastedTextMarkers(text, pastedText) }),
		text,
	};
};

const compactionSummarySchema = z.object({
	attachments: z
		.array(
			attachmentReferenceSchema.extend({
				available: z.boolean(),
				payloadOmitted: z.literal(true),
			})
		)
		.optional(),
	coveredMessageIds: z
		.array(z.string().min(1))
		.transform((messageIds) => messageIds.map(toSessionMessageId)),
	fileOperations: z
		.object({
			modified: z.array(z.string()),
			read: z.array(z.string()),
		})
		.optional(),
	formatVersion: z.literal(1),
	focus: z.string().optional(),
	text: z.string(),
});

const parseCompactionSummary = (value: unknown): SessionCompaction["summary"] =>
	compactionSummarySchema.parse(value);

const clearAttachmentRoot = async (root: string): Promise<void> => {
	await fs.mkdir(root, { recursive: true });
	const entries = await fs.readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		await fs.rm(path.join(root, entry.name), { force: true, recursive: true });
	}
};

const writePromptHistory = (
	db: SessionDatabase,
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
			JSON.stringify(entry.fileTokens ?? []) &&
		JSON.stringify(latest.entry?.pastedText ?? []) ===
			JSON.stringify(entry.pastedText ?? [])
	) {
		return;
	}
	db.transaction((tx) => {
		tx.insert(promptHistory)
			.values({
				createdAt: new Date(),
				entryJson: serializeJson({
					...pickTruthy({
						fileTokens: entry.fileTokens,
						pastedText: entry.pastedText,
					}),
					files: entry.files,
				}),
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
	db: SessionDatabase,
	attachmentStore?: SessionAttachmentStore
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
			.map((row) => parsePromptHistoryEntry(row.entry, row.text));

	const externalizeFiles = async (
		files: PromptHistoryEntry["files"]
	): Promise<PromptHistoryEntry["files"]> => {
		if (!attachmentStore || files.length === 0) {
			return files;
		}
		const [message] = await attachmentStore.externalizeMessages([
			{
				id: toSessionMessageId("prompt-history"),
				parts: files,
				role: "user",
			} satisfies SessionMessage,
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
			const original = parsePromptHistoryEntry(row.entry, row.text);
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
							entryJson: serializeJson({
								...pickTruthy({
									fileTokens: entry.fileTokens,
									pastedText: entry.pastedText,
								}),
								files: entry.files,
							}),
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
type SessionRow = typeof session.$inferSelect;
type CompactionRow = typeof sessionCompaction.$inferSelect;
type SessionRecordRow = typeof sessionRecord.$inferSelect;
type SessionUsageEntryRow = typeof sessionUsageEntry.$inferSelect;

const toSessionCompaction = (row: CompactionRow): SessionCompaction => {
	const summarizationModel = providerModelSelectionSchema.parse(
		row.summarizationModelJson
	);
	const summary = parseCompactionSummary(row.summaryJson);
	return {
		completedAt: row.completedAt,
		createdAt: row.createdAt,
		firstKeptUiMessageId: toSessionMessageId(row.firstKeptUiMessageId),
		firstKeptAssistantPartIndex: row.firstKeptAssistantPartIndex ?? undefined,
		focus: row.focus ?? undefined,
		id: toCompactionId(row.id),
		priorCompactionId: row.priorCompactionId
			? toCompactionId(row.priorCompactionId)
			: undefined,
		sequence: row.sequence,
		sessionId: toSessionId(row.sessionId),
		summarizationModel,
		summarizationThinkingLevel: row.summarizationThinkingLevel ?? undefined,
		summarizationUsage: row.summarizationUsageJson ?? undefined,
		summary,
		throughMessageUiId: toSessionMessageId(row.throughMessageUiId),
		estimatedTokensAfter: row.estimatedTokensAfter,
		tokensBefore: row.tokensBefore,
		trigger: row.trigger,
	};
};

export type DrizzleSessionStoreOptions = {
	attachmentRoot?: string;
	attachmentStore?: SessionAttachmentStore;
	operationalDatabase?: SessionDatabase;
	sessionLogRoot?: string;
	snapshotRoot?: string;
	workspaceRoot?: string;
};

const hashWorkspace = (rootPath: string): string =>
	new Bun.CryptoHasher("sha256").update(rootPath).digest("hex").slice(0, 16);

const ensureWorkspace = (db: SessionDatabase, rootPath: string) => {
	const now = new Date();
	const workspace = {
		createdAt: now,
		id: toWorkspaceId(hashWorkspace(rootPath)),
		rootPath,
		updatedAt: now,
	};

	db.insert(sessionWorkspace)
		.values(workspace)
		.onConflictDoUpdate({
			set: { rootPath, updatedAt: now },
			target: sessionWorkspace.id,
		})
		.run();

	return workspace;
};

const sessionIsBoundToWorkspace = (
	db: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): boolean => {
	const binding = db
		.select({ workspaceId: localSessionBinding.workspaceId })
		.from(localSessionBinding)
		.where(eq(localSessionBinding.sessionId, sessionId))
		.get();
	return binding?.workspaceId === workspaceId;
};

const assertSessionBinding = (
	db: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): void => {
	const binding = db
		.select({ sessionId: localSessionBinding.sessionId })
		.from(localSessionBinding)
		.where(
			and(
				eq(localSessionBinding.sessionId, sessionId),
				eq(localSessionBinding.workspaceId, workspaceId)
			)
		)
		.get();
	if (binding === undefined) {
		throw new Error("Session not found");
	}
};

const deriveSessionTitle = (messages: SessionMessage[]): string => {
	for (const message of messages) {
		if (message.role !== "user" || !isArray(message.parts)) {
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

const toSession = (row: SessionRow): Session => {
	const model = normalizeProviderModelSelection(row.modelJson) ?? undefined;
	return {
		createdAt: row.createdAt,
		id: toSessionId(row.id),
		lastMessageAt: row.lastMessageAt ?? null,
		pinned: row.pinned,
		title: row.title ?? UNTITLED_SESSION_TITLE,
		...omitUndefined({
			model,
			thinkingLevel: row.thinkingLevel ?? undefined,
		}),
	};
};
const toSessionRecordModel = (
	model: Pick<
		SessionRecord["model"],
		"modelId" | "pluginProviderSource" | "providerId"
	>,
	thinkingLevel: SessionRecord["model"]["thinkingLevel"]
): SessionRecord["model"] => ({
	modelId: model.modelId,
	providerId: model.providerId,
	...omitUndefined({
		pluginProviderSource: model.pluginProviderSource,
		thinkingLevel,
	}),
});
const toSessionUsageEntry = (row: SessionUsageEntryRow): SessionUsageEntry => {
	if (row.kind !== "cache-warm" && row.kind !== "compaction-summary") {
		throw new Error(`Unsupported Session Usage Entry kind: ${row.kind}`);
	}
	return {
		createdAt: row.createdAt,
		id: toSessionUsageEntryId(row.id),
		kind: row.kind,
		model: providerModelSelectionSchema.parse(row.modelJson),
		sessionId: toSessionId(row.sessionId),
		usage: modelUsageSchema.parse(row.usageJson),
	};
};

const toSessionRecord = (row: SessionRecordRow): SessionRecord => {
	const record = {
		agentId: agentIdSchema.parse(row.agentId),
		id: toSessionRecordId(row.recordId),
		messages: row.messagesJson,
		model: row.modelJson,
		outcome: row.outcomeJson,
		turnId: toAgentTurnId(row.turnId),
		version: row.version,
	};
	const validationError = getSessionRecordValidationError(record);
	if (!isNull(validationError)) {
		throw new SessionRecordInvariantError(
			`Invalid persisted Session Record: ${validationError}`
		);
	}
	return record as unknown as SessionRecord;
};
const collectLiveAttachmentIds = (
	db: SessionDatabase,
	operationalDb: SessionDatabase
): Set<string> => {
	const live = new Set<string>();
	const recordRows = db
		.select({ messages: sessionRecord.messagesJson })
		.from(sessionRecord)
		.all();
	for (const row of recordRows) {
		for (const message of row.messages) {
			for (const part of message.parts) {
				if (isSessionAttachmentReferencePart(part)) {
					live.add(part.attachmentId);
				}
			}
		}
	}
	const historyRows = operationalDb
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
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	input: AppendSessionCompactionInput
): SessionCompaction => {
	assertSessionBinding(operationalDb, workspaceId, input.sessionId);
	return db.transaction((tx) => {
		const sessionRow = tx
			.select({ id: session.id })
			.from(session)
			.where(eq(session.id, input.sessionId))
			.get();
		if (!sessionRow) {
			throw new Error("Session not found");
		}

		const latest = tx
			.select({ sequence: sessionCompaction.sequence })
			.from(sessionCompaction)
			.where(eq(sessionCompaction.sessionId, input.sessionId))
			.orderBy(desc(sessionCompaction.sequence))
			.limit(1)
			.get();
		const sequence = (latest?.sequence ?? 0) + 1;
		const id = input.id ?? createCompactionId();
		const createdAt = input.createdAt ?? new Date();
		const completedAt = input.completedAt ?? createdAt;
		const row = {
			completedAt,
			createdAt,
			firstKeptAssistantPartIndex: input.firstKeptAssistantPartIndex ?? null,
			firstKeptUiMessageId: input.firstKeptUiMessageId,
			summarizationThinkingLevel: input.summarizationThinkingLevel ?? null,
			focus: input.focus ?? null,
			id,
			priorCompactionId: input.priorCompactionId ?? null,
			sequence,
			sessionId: input.sessionId,
			summarizationModelJson: serializeJson(input.summarizationModel),
			summarizationUsageJson: serializeJson(input.summarizationUsage ?? null),
			summaryJson: serializeJson(input.summary),
			throughMessageUiId: input.throughMessageUiId,
			estimatedTokensAfter: input.estimatedTokensAfter,
			tokensBefore: input.tokensBefore,
			trigger: input.trigger,
		};
		tx.insert(sessionCompaction).values(row).run();
		return toSessionCompaction(row);
	});
};

const writeSessionRecordCheckpoint = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	{
		sessionModel,
		sessionThinkingLevel,
		record,
		sessionId,
	}: CommitSessionRecordInput
): void => {
	const validationError = getSessionRecordValidationError(record);
	if (!isNull(validationError)) {
		throw new SessionRecordInvariantError(
			`Invalid Session Record: ${validationError}`,
			{ cause: new Error(validationError) }
		);
	}
	const modelJson = serializeJson(
		toSessionRecordModel(record.model, record.model.thinkingLevel)
	);
	assertSessionBinding(operationalDb, workspaceId, sessionId);
	db.transaction((tx) => {
		const sessionRow = tx
			.select({ id: session.id })
			.from(session)
			.where(eq(session.id, sessionId))
			.get();
		if (!sessionRow) {
			throw new Error("Session not found");
		}

		const latest = tx
			.select({ position: sessionRecord.position })
			.from(sessionRecord)
			.where(eq(sessionRecord.sessionId, sessionId))
			.orderBy(desc(sessionRecord.position))
			.limit(1)
			.get();
		const now = new Date();
		const sessionRecordValues: typeof sessionRecord.$inferInsert = {
			createdAt: now,
			agentId: record.agentId,
			messagesJson: serializeJson([...record.messages]),
			modelJson,
			outcomeJson: serializeJson(record.outcome),
			position: (latest?.position ?? -1) + 1,
			recordId: record.id,
			sessionId,
			turnId: record.turnId,
			version: record.version,
		};
		tx.insert(sessionRecord).values(sessionRecordValues).run();

		tx.update(session)
			.set({
				lastMessageAt: now,
				...(isUndefined(sessionModel)
					? {}
					: {
							modelJson: serializeJson(sessionModel),
							thinkingLevel: sessionThinkingLevel ?? null,
						}),
				updatedAt: now,
			})
			.where(eq(session.id, sessionId))
			.run();
	});
};
const writeSessionUsageEntry = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	input: CreateSessionUsageEntryInput
): SessionUsageEntry => {
	const createdAt = input.createdAt ?? new Date();
	const usage = modelUsageSchema.parse(input.usage);
	assertSessionBinding(operationalDb, workspaceId, input.sessionId);
	return db.transaction((tx) => {
		const sessionRow = tx
			.select({ id: session.id })
			.from(session)
			.where(eq(session.id, input.sessionId))
			.get();
		if (!sessionRow) {
			throw new Error("Session not found");
		}
		tx.insert(sessionUsageEntry)
			.values({
				createdAt,
				id: input.id,
				kind: input.kind,
				modelJson: serializeJson(input.model),
				sessionId: input.sessionId,
				usageJson: serializeJson(usage),
			})
			.onConflictDoNothing()
			.run();
		const row = tx
			.select()
			.from(sessionUsageEntry)
			.where(eq(sessionUsageEntry.id, input.id))
			.get();
		if (row === undefined) {
			throw new Error("Session Usage Entry could not be persisted.");
		}
		const persisted = toSessionUsageEntry(row);
		if (
			persisted.sessionId !== input.sessionId ||
			persisted.kind !== input.kind ||
			!Bun.deepEquals(persisted.model, input.model, true) ||
			!Bun.deepEquals(persisted.usage, usage, true)
		) {
			throw new Error("Session Usage Entry identity was reused with new data.");
		}
		return persisted;
	});
};

const readSessionUsageEntries = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): SessionUsageEntry[] => {
	if (!sessionIsBoundToWorkspace(operationalDb, workspaceId, sessionId)) {
		return [];
	}
	return db
		.select({ entry: sessionUsageEntry })
		.from(sessionUsageEntry)
		.where(eq(sessionUsageEntry.sessionId, sessionId))
		.orderBy(asc(sessionUsageEntry.createdAt), asc(sessionUsageEntry.id))
		.all()
		.map(({ entry }) => toSessionUsageEntry(entry));
};

const updateSessionSubmissionCheckpoint = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	input: UpdateSessionSubmissionInput
): void => {
	if (input.status === "failed" && !input.failure) {
		throw new Error("A failed Submission requires a failure reason.");
	}
	assertSessionBinding(operationalDb, workspaceId, input.sessionId);
	db.transaction((tx) => {
		const row = tx
			.select({ record: sessionRecord })
			.from(sessionRecord)
			.where(
				and(
					eq(sessionRecord.recordId, input.recordId),
					eq(sessionRecord.sessionId, input.sessionId)
				)
			)
			.get();
		if (row === undefined) {
			throw new Error("Steered Session Record not found.");
		}
		const record = toSessionRecord(row.record);
		if (record.outcome.kind !== "user") {
			throw new SessionRecordInvariantError(
				"Only a user Submission Record can change processing state."
			);
		}
		const messageIndex = record.messages.findIndex(
			(message) => message.role === "user" && message.id === input.messageId
		);
		const message = record.messages[messageIndex];
		if (
			message === undefined ||
			message.metadata?.submissionId !== input.submissionId
		) {
			throw new SessionRecordInvariantError(
				"Steered Session Record identity does not match the Submission."
			);
		}
		const updatedMessage = withSubmissionStatus(message, {
			failure: input.failure,
			status: input.status,
			submissionId: input.submissionId,
		});
		const messages = [...record.messages];
		messages[messageIndex] = updatedMessage;
		const validationError = getSessionRecordValidationError({
			...record,
			messages,
		});
		if (!isNull(validationError)) {
			throw new SessionRecordInvariantError(
				`Invalid Submission state update: ${validationError}`,
				{ cause: new Error(validationError) }
			);
		}
		const updated = tx
			.update(sessionRecord)
			.set({ messagesJson: serializeJson(messages) })
			.where(
				and(
					eq(sessionRecord.recordId, input.recordId),
					eq(sessionRecord.sessionId, input.sessionId)
				)
			)
			.returning({ recordId: sessionRecord.recordId })
			.get();
		if (updated === undefined) {
			throw new Error("Steered Session Record update was not applied.");
		}
	});
};

const readSessionRecordRows = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): SessionRecordRow[] => {
	if (!sessionIsBoundToWorkspace(operationalDb, workspaceId, sessionId)) {
		return [];
	}
	return db
		.select({ record: sessionRecord })
		.from(sessionRecord)
		.where(eq(sessionRecord.sessionId, sessionId))
		.orderBy(asc(sessionRecord.position))
		.all()
		.map(({ record }) => record);
};

const readSessionRecords = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): SessionRecord[] =>
	readSessionRecordRows(db, operationalDb, workspaceId, sessionId).map(
		toSessionRecord
	);

export type DrizzleSessionStore = SessionProjectionStore &
	Readonly<{
		jsonlProjection: SessionJsonlProjection;
		setAttachmentCollectionBarrier: (barrier: () => Promise<void>) => void;
	}>;

export const createDrizzleSessionStore = (
	database?: SessionDatabase,
	options: DrizzleSessionStoreOptions = {}
): DrizzleSessionStore => {
	const db = database ?? createDatabase().db;
	const operationalDb = options.operationalDatabase ?? db;
	const sessionLogRoot =
		options.sessionLogRoot ??
		resolveLocalSessionLogRoot(operationalDb.$client.filename);

	const attachmentRoot =
		options.attachmentRoot ??
		resolveLocalAttachmentRoot(operationalDb.$client.filename);
	const snapshotRoot =
		options.snapshotRoot ??
		resolveLocalSnapshotRoot(operationalDb.$client.filename);
	const attachmentStore =
		options.attachmentStore ??
		createSessionAttachmentStore({
			repository: createDrizzleAttachmentMetadataRepository(operationalDb),
			root: attachmentRoot,
		});
	const externalizeAttachments = (
		messages: readonly SessionMessage[],
		signal?: AbortSignal,
		externalizationOptions?: AttachmentExternalizationOptions
	): Promise<SessionMessage[]> =>
		attachmentStore
			? attachmentStore.externalizeMessages(
					messages,
					signal,
					externalizationOptions
				)
			: Promise.resolve([...messages]);
	const hydrateAttachments = (
		messages: readonly SessionMessage[],
		hydrationOptions: AttachmentHydrationOptions
	): Promise<SessionMessage[]> =>
		attachmentStore
			? attachmentStore.hydrateMessages(messages, hydrationOptions)
			: Promise.resolve([...messages]);
	const promptHistoryStore = createPromptHistory(
		operationalDb,
		attachmentStore
	);
	const workspace = ensureWorkspace(
		operationalDb,
		options.workspaceRoot ?? process.cwd()
	);
	const jsonlProjection = createSessionJsonlProjection(
		db,
		operationalDb,
		workspace.id
	);
	const fileObservationStore = createDrizzleFileObservationStore(
		operationalDb,
		snapshotRoot,
		workspace.id
	);
	let attachmentCollectionBarrier: (() => Promise<void>) | undefined;
	const collectAttachments = async (
		safetyWindowMs = 60_000
	): Promise<AttachmentMaintenanceReport> => {
		await attachmentCollectionBarrier?.();
		return attachmentStore
			? attachmentStore.collect({
					liveAttachmentIds: collectLiveAttachmentIds(db, operationalDb),
					safetyWindowMs,
				})
			: {
					orphanBytes: 0,
					orphanCount: 0,
					reclaimedBytes: 0,
					reclaimedCount: 0,
				};
	};
	const assertRecoveryResolvedForSessionDeletion = async (
		sessionId: SessionId
	): Promise<void> => {
		const recovery = fileObservationStore.recovery;
		if (recovery === undefined) {
			return;
		}
		await recovery.ensureReady?.();
		const unresolved = (await recovery.listUnresolvedRecoveries()).filter(
			(entry) => entry.originSessionId === sessionId
		);
		if (unresolved.length === 0) {
			return;
		}
		const error = new Error(
			"Session deletion is blocked until its unresolved recovery is resolved, exported, discarded, or cancelled."
		) as Error & { code: string; details: Record<string, unknown> };
		error.code = "session-recovery-required";
		error.details = {
			actions: ["resolve", "export", "discard", "cancel"],
			recoveryIds: unresolved.map(({ id }) => id),
		};
		throw error;
	};

	return {
		jsonlProjection,
		setAttachmentCollectionBarrier: (barrier) => {
			attachmentCollectionBarrier = barrier;
		},
		appendCompaction: (input) =>
			Promise.resolve(appendCompaction(db, operationalDb, workspace.id, input)),
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
			createdAt,
			id: requestedId,
			initialRecord,
			agent,
			message,
			model,
			turnId,
			thinkingLevel,
		}: CreateSessionInput) => {
			const durableMessage = toDurableSessionMessageRecord(message);
			if (isUndefined(durableMessage) || durableMessage.role !== "user") {
				throw new Error("Initial session message has no durable parts.");
			}
			const id = requestedId ?? createSessionId();
			const now = createdAt ?? new Date();
			const recordModel = toSessionRecordModel(
				initialRecord?.model ?? message.metadata?.model ?? model,
				initialRecord?.model.thinkingLevel ??
					message.metadata?.thinkingLevel ??
					thinkingLevel
			);

			operationalDb
				.insert(localSessionBinding)
				.values({ sessionId: id, workspaceId: workspace.id })
				.run();
			db.transaction((tx) => {
				tx.insert(session)
					.values({
						createdAt: now,
						id,
						lastMessageAt: now,
						modelJson: serializeJson(model),
						pinned: false,
						title: deriveSessionTitle([message]),
						updatedAt: now,
						thinkingLevel,
					})
					.run();
				tx.insert(sessionRecord)
					.values({
						agentId: agent,
						createdAt: now,
						messagesJson: serializeJson(
							initialRecord?.messages ?? [durableMessage]
						),
						modelJson: serializeJson(recordModel),
						outcomeJson: serializeJson(
							initialRecord?.outcome ?? { kind: "user" }
						),
						position: 0,
						recordId: initialRecord?.id ?? createSessionRecordId(),
						sessionId: id,
						turnId: initialRecord?.turnId ?? turnId,
						version: initialRecord?.version ?? SESSION_RECORD_VERSION,
					})
					.run();
			});

			return { id };
		},
		createSessionUsageEntry: async (input) =>
			writeSessionUsageEntry(db, operationalDb, workspace.id, input),
		listSessionUsageEntries: async (sessionId) =>
			readSessionUsageEntries(db, operationalDb, workspace.id, sessionId),
		createEmptySession: async ({
			createdAt,
			id = createSessionId(),
			model,
			thinkingLevel,
		}) => {
			const now = createdAt ?? new Date();
			operationalDb
				.insert(localSessionBinding)
				.values({ sessionId: id, workspaceId: workspace.id })
				.run();
			db.transaction((tx) => {
				tx.insert(session)
					.values({
						createdAt: now,
						id,
						lastMessageAt: null,
						modelJson: model === undefined ? undefined : serializeJson(model),
						pinned: false,
						title: UNTITLED_SESSION_TITLE,
						updatedAt: now,
						thinkingLevel,
					})
					.run();
			});
			return { id };
		},

		deleteSession: async (sessionId: SessionId) => {
			await assertRecoveryResolvedForSessionDeletion(sessionId);
			const binding = operationalDb
				.select({ sessionId: localSessionBinding.sessionId })
				.from(localSessionBinding)
				.where(
					and(
						eq(localSessionBinding.sessionId, sessionId),
						eq(localSessionBinding.workspaceId, workspace.id)
					)
				)
				.get();
			if (binding === undefined) {
				return;
			}
			db.delete(session).where(eq(session.id, sessionId)).run();
			operationalDb
				.delete(localSessionBinding)
				.where(eq(localSessionBinding.sessionId, sessionId))
				.run();
			await collectAttachments().catch(() => undefined);
			const prune = fileObservationStore.pruneSnapshots;
			if (prune) {
				await prune().catch(() => undefined);
			}
		},
		resetSessionData: async () => {
			const recovery = fileObservationStore.recovery;
			if (recovery !== undefined) {
				await recovery.ensureReady?.();
				const unresolved = await recovery.listUnresolvedRecoveries();
				if (unresolved.length > 0) {
					throw new Error(
						"Reset is blocked until every workspace recovery is reconciled or discarded."
					);
				}
			}
			db.transaction((tx) => {
				tx.delete(sessionCompaction).run();
				tx.delete(sessionRecord).run();
				tx.delete(sessionUsageEntry).run();
				tx.delete(session).run();
				tx.delete(sessionProjectionCursor).run();
			});
			operationalDb.transaction((tx) => {
				tx.delete(localSessionBinding).run();
				tx.delete(sessionAttachment).run();
			});
			await clearAttachmentRoot(attachmentRoot);
			const prune = fileObservationStore.pruneSnapshots;
			if (prune) {
				await prune().catch(() => undefined);
			}
		},

		getCompactions: (sessionId: SessionId) => {
			if (!sessionIsBoundToWorkspace(operationalDb, workspace.id, sessionId)) {
				return Promise.resolve([]);
			}
			const rows = db
				.select({ compaction: sessionCompaction })
				.from(sessionCompaction)
				.where(eq(sessionCompaction.sessionId, sessionId))
				.orderBy(asc(sessionCompaction.sequence))
				.all();
			return Promise.resolve(
				rows.map(({ compaction }) => toSessionCompaction(compaction))
			);
		},

		getLatestCompaction: (sessionId: SessionId) => {
			if (!sessionIsBoundToWorkspace(operationalDb, workspace.id, sessionId)) {
				return Promise.resolve(null);
			}
			const row = db
				.select({ compaction: sessionCompaction })
				.from(sessionCompaction)
				.where(eq(sessionCompaction.sessionId, sessionId))
				.orderBy(desc(sessionCompaction.sequence))
				.limit(1)
				.get();
			return Promise.resolve(row ? toSessionCompaction(row.compaction) : null);
		},

		commitSessionRecord: async ({
			sessionModel,
			sessionThinkingLevel,
			record,
			sessionId,
		}) => {
			writeSessionRecordCheckpoint(db, operationalDb, workspace.id, {
				sessionModel,
				sessionThinkingLevel,
				record,
				sessionId,
			});
		},
		listSessionRecords: async (sessionId: SessionId) =>
			readSessionRecords(db, operationalDb, workspace.id, sessionId),
		updateSessionSubmission: async (input) =>
			updateSessionSubmissionCheckpoint(db, operationalDb, workspace.id, input),
		getSession: (sessionId: SessionId) => {
			try {
				assertSessionBinding(operationalDb, workspace.id, sessionId);
			} catch (error) {
				return Promise.reject(error);
			}
			const row = db
				.select({ session })
				.from(session)
				.where(eq(session.id, sessionId))
				.get()?.session;

			if (!row) {
				return Promise.reject(new Error("Session not found"));
			}

			return Promise.resolve(toSession(row));
		},
		acquireSessionWriter: (sessionId, writerOptions) =>
			acquireSessionWriterLock(sessionLogRoot, sessionId, writerOptions),
		getEditMode: async (sessionId: SessionId): Promise<EditMode> => {
			assertSessionBinding(operationalDb, workspace.id, sessionId);
			const row = db
				.select({ editMode: session.editMode })
				.from(session)
				.where(eq(session.id, sessionId))
				.get();
			return row?.editMode ?? "hashline";
		},
		setEditMode: async (sessionId: SessionId, mode: EditMode) => {
			assertSessionBinding(operationalDb, workspace.id, sessionId);
			db.transaction((tx) => {
				tx.update(session)
					.set({ editMode: mode, updatedAt: new Date() })
					.where(eq(session.id, sessionId))
					.run();
			});
		},
		listSessions: () => {
			const boundSessionIds = new Set(
				operationalDb
					.select({ sessionId: localSessionBinding.sessionId })
					.from(localSessionBinding)
					.where(eq(localSessionBinding.workspaceId, workspace.id))
					.all()
					.map(({ sessionId }) => sessionId)
			);
			const rows = db
				.select({ session })
				.from(session)
				.orderBy(
					desc(session.pinned),
					desc(session.lastMessageAt),
					desc(session.createdAt)
				)
				.all()
				.filter(({ session: row }) => boundSessionIds.has(row.id));

			return Promise.resolve(rows.map(({ session: row }) => toSession(row)));
		},
		listRecentModelSelections: (limit: number) => {
			if (limit <= 0) {
				return [];
			}
			const boundSessionIds = new Set(
				operationalDb
					.select({ sessionId: localSessionBinding.sessionId })
					.from(localSessionBinding)
					.where(eq(localSessionBinding.workspaceId, workspace.id))
					.all()
					.map(({ sessionId }) => sessionId)
			);
			const rows = db
				.select({
					createdAt: sessionRecord.createdAt,
					model: sessionRecord.modelJson,
					sessionId: sessionRecord.sessionId,
				})
				.from(sessionRecord)
				.orderBy(desc(sessionRecord.createdAt))
				.all()
				.filter(({ sessionId }) => boundSessionIds.has(sessionId));
			const result: ProviderModelSelection[] = [];
			const seen = new Set<string>();
			for (const row of rows) {
				const parsed = providerModelSelectionSchema.safeParse({
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

		updateSession: (sessionId: SessionId, data: UpdateSessionInput) => {
			assertSessionBinding(operationalDb, workspace.id, sessionId);
			db.transaction((tx) => {
				tx.update(session)
					.set({
						updatedAt: new Date(),
						...omitUndefined({
							title: data.title,
							pinned: data.pinned,
						}),
					})
					.where(eq(session.id, sessionId))
					.run();
			});

			return Promise.resolve();
		},
		fileObservationStore,
		attachmentStore,
		externalizeAttachments,
		hydrateAttachments,
		collectAttachments,
	};
};
