import {
	agentIdSchema,
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
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull as isSqlNull,
	lt,
	lte,
	or,
} from "drizzle-orm";
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
	AttachmentExternalizationLease,
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
import { createDrizzleRecoveryStore } from "./recovery-store";
import {
	localSessionBinding,
	promptHistory,
	type SerializedJson,
	session,
	sessionCatalogDeletionState,
	sessionCatalogVersion,
	sessionCompaction,
	sessionProjectionCursor,
	sessionProjectionState,
	sessionRecord,
	sessionRecordVersion,
	sessionUsageEntry,
	sessionWorkspace,
} from "./schema";
import {
	type SessionJsonlProjection,
	SessionLogError,
} from "./session-jsonl-codec";
import { createSessionJsonlProjection } from "./session-jsonl-projection";
import {
	type SessionCatalogPageCursor,
	type SessionCatalogPageKey,
	type SessionCatalogReadPoint,
	type SessionHistoryPageCursor,
	type SessionHistoryReadPoint,
	SessionPaginationError,
	sessionCatalogReadPoint,
	sessionHistoryReadPoint,
} from "./session-pagination";
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
	): Promise<
		Readonly<{
			files: PromptHistoryEntry["files"];
			release: () => Promise<void>;
		}>
	> => {
		if (!attachmentStore || files.length === 0) {
			return { files, release: async () => undefined };
		}
		const lease = await attachmentStore.externalizeMessagesWithLease([
			{
				id: toSessionMessageId("prompt-history"),
				parts: files,
				role: "user",
			} satisfies SessionMessage,
		]);
		return {
			files: (lease.messages[0]?.parts ?? []).filter(
				(part): part is PromptHistoryEntry["files"][number] =>
					part.type === "file"
			),
			release: lease.release,
		};
	};
	const migrateLegacyEntry = async (
		entry: PromptHistoryEntry
	): Promise<
		Readonly<{ entry: PromptHistoryEntry; release?: () => Promise<void> }>
	> => {
		if (!entry.files.some(isLegacyImagePart)) {
			return { entry };
		}
		try {
			const externalized = await externalizeFiles(entry.files);
			return {
				entry: { ...entry, files: externalized.files },
				release: externalized.release,
			};
		} catch {
			return { entry };
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
			release?: () => Promise<void>;
		}> = [];
		for (const row of rows) {
			const original = parsePromptHistoryEntry(row.entry, row.text);
			const result = await migrateLegacyEntry(original);
			migrated.push({
				changed:
					JSON.stringify(result.entry.files) !== JSON.stringify(original.files),
				entry: result.entry,
				id: row.id,
				...omitUndefined({ release: result.release }),
			});
		}
		const changes = migrated.filter(({ changed }) => changed);
		try {
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
		} finally {
			await Promise.all(
				migrated.flatMap(({ release }) => (release ? [release()] : []))
			);
		}
	};

	const record = (entry: PromptHistoryEntry): Promise<void> => {
		if (!attachmentStore) {
			writePromptHistory(db, entry);
			return Promise.resolve();
		}
		return (async () => {
			const externalized = await externalizeFiles(entry.files);
			try {
				writePromptHistory(db, { ...entry, files: externalized.files });
			} finally {
				await externalized.release();
			}
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

export type SessionCatalogPageProjectionInput = Readonly<{
	cursor?: SessionCatalogPageCursor;
	limit: number;
}>;

export type SessionCatalogPageProjection = Readonly<{
	hasMore: boolean;
	lastKey?: SessionCatalogPageKey;
	readPoint: SessionCatalogReadPoint;
	sessions: Session[];
}>;

export type SessionHistoryPageProjectionInput = Readonly<{
	cursor?: SessionHistoryPageCursor;
	limit: number;
}>;

export type SessionHistoryPageProjection = Readonly<{
	beforeSequence?: number;
	compactions: SessionCompaction[];
	hasMore: boolean;
	readPoint: SessionHistoryReadPoint;
	records: SessionRecord[];
	session: Session;
}>;

export type SessionStatisticsProjection = Readonly<{
	compactions: SessionCompaction[];
	readPoint: SessionHistoryReadPoint;
	records: SessionRecord[];
	usageEntries: SessionUsageEntry[];
}>;
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
		compactionId: row.compactionId
			? toCompactionId(row.compactionId)
			: undefined,
		costUsd: row.costUsd,
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
	operationalDb: SessionDatabase
): Set<string> => {
	const live = new Set<string>();
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
			sourceSequence: 0,
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
				compactionId: input.compactionId ?? null,
				costUsd: input.costUsd,
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
			persisted.compactionId !== input.compactionId ||
			persisted.costUsd !== input.costUsd ||
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

const toCatalogSession = (
	row: typeof sessionCatalogVersion.$inferSelect
): Session => {
	const model = normalizeProviderModelSelection(row.modelJson) ?? undefined;
	return {
		createdAt: row.createdAt,
		id: toSessionId(row.sessionId),
		lastMessageAt: row.lastMessageAt,
		pinned: row.pinned,
		title: row.title,
		...omitUndefined({
			model,
			thinkingLevel: row.thinkingLevel ?? undefined,
		}),
	};
};

const pageProjectionBlocked = (
	sessionIds: readonly SessionId[],
	message: string
): never => {
	const sessionId = sessionIds[0];
	if (sessionId !== undefined) {
		throw new SessionLogError("session_projection_blocked", sessionId, message);
	}
	const error = new Error(message) as Error & { code: string };
	error.code = "session_projection_blocked";
	throw error;
};

type SessionTransaction = Parameters<
	SessionDatabase["transaction"]
>[0] extends (transaction: infer Transaction) => unknown
	? Transaction
	: never;

const recordDeletionCursorInvalidation = (
	tx: SessionTransaction,
	workspaceId: WorkspaceId
): void => {
	const state = tx
		.select({ catalogRevision: sessionProjectionState.catalogRevision })
		.from(sessionProjectionState)
		.where(eq(sessionProjectionState.id, 1))
		.get();
	if (state === undefined || !Number.isSafeInteger(state.catalogRevision + 1)) {
		throw new Error("Session catalog deletion revision is unavailable.");
	}
	const revision = state.catalogRevision + 1;
	let projectionId: string | undefined;
	try {
		tx.insert(sessionCatalogDeletionState)
			.values({ latestDeletionRevision: revision, workspaceId })
			.onConflictDoUpdate({
				set: { latestDeletionRevision: revision },
				target: sessionCatalogDeletionState.workspaceId,
			})
			.run();
	} catch {
		projectionId = crypto.randomUUID();
	}
	tx.update(sessionProjectionState)
		.set({
			catalogRevision: revision,
			latestDeletionRevision: revision,
			...omitUndefined({ projectionId }),
		})
		.where(eq(sessionProjectionState.id, 1))
		.run();
};

type SessionPaginationState = Pick<
	typeof sessionProjectionState.$inferSelect,
	| "catalogRevision"
	| "generation"
	| "paginationVersion"
	| "projectionId"
	| "status"
>;

type SessionPaginationMaintenanceState = SessionPaginationState &
	Pick<typeof sessionProjectionState.$inferSelect, "latestDeletionRevision">;

const requireReadyPaginationMaintenance = <
	State extends SessionPaginationState,
>(
	maintenance: State | undefined,
	sessionIds: readonly SessionId[],
	message: string
): State => {
	if (maintenance === undefined) {
		throw new Error("Session projection maintenance state is missing.");
	}
	if (maintenance.status !== "ready" || maintenance.paginationVersion !== 2) {
		pageProjectionBlocked(sessionIds, message);
	}
	return maintenance;
};

const resolveCatalogReadPoint = (
	cursor: SessionCatalogPageCursor | undefined,
	workspaceId: WorkspaceId,
	maintenance: SessionPaginationMaintenanceState
): SessionCatalogReadPoint => {
	if (cursor === undefined) {
		return {
			catalogRevision: maintenance.catalogRevision,
			generation: maintenance.generation,
			kind: "catalog-read-point",
			latestDeletionRevision: maintenance.latestDeletionRevision,
			projectionId: maintenance.projectionId,
			version: 1,
			workspaceId,
		};
	}
	if (cursor.workspaceId !== workspaceId) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session cursor belongs to a different workspace."
		);
	}
	if (cursor.projectionId !== maintenance.projectionId) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session cursor expired after the projection was reset."
		);
	}
	if (cursor.generation !== maintenance.generation) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session cursor expired after projection maintenance."
		);
	}
	if (cursor.catalogRevision > maintenance.catalogRevision) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session cursor refers to a future catalog revision."
		);
	}
	if (maintenance.latestDeletionRevision > cursor.catalogRevision) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session cursor expired after a Session was deleted."
		);
	}
	return sessionCatalogReadPoint(cursor);
};

const catalogPageAfter = (cursorPosition: SessionCatalogPageKey) => {
	const afterCreatedAt = or(
		lt(sessionCatalogVersion.createdAt, new Date(cursorPosition.createdAt)),
		and(
			eq(sessionCatalogVersion.createdAt, new Date(cursorPosition.createdAt)),
			gt(sessionCatalogVersion.sessionId, cursorPosition.sessionId)
		)
	);
	const afterLastMessageAt =
		cursorPosition.lastMessageAt === null
			? and(isSqlNull(sessionCatalogVersion.lastMessageAt), afterCreatedAt)
			: or(
					lt(
						sessionCatalogVersion.lastMessageAt,
						new Date(cursorPosition.lastMessageAt)
					),
					isSqlNull(sessionCatalogVersion.lastMessageAt),
					and(
						eq(
							sessionCatalogVersion.lastMessageAt,
							new Date(cursorPosition.lastMessageAt)
						),
						afterCreatedAt
					)
				);
	return or(
		lt(sessionCatalogVersion.pinned, cursorPosition.pinned),
		and(
			eq(sessionCatalogVersion.pinned, cursorPosition.pinned),
			afterLastMessageAt
		)
	);
};

const readSessionCatalogPageProjection = (
	db: SessionDatabase,
	workspaceId: WorkspaceId,
	input: SessionCatalogPageProjectionInput
): SessionCatalogPageProjection =>
	db.transaction((tx) => {
		const projectionMaintenance = requireReadyPaginationMaintenance(
			tx
				.select({
					catalogRevision: sessionProjectionState.catalogRevision,
					generation: sessionProjectionState.generation,
					projectionId: sessionProjectionState.projectionId,
					latestDeletionRevision: sessionProjectionState.latestDeletionRevision,
					paginationVersion: sessionProjectionState.paginationVersion,
					status: sessionProjectionState.status,
				})
				.from(sessionProjectionState)
				.where(eq(sessionProjectionState.id, 1))
				.get(),
			[],
			"Session pagination projection is unavailable; run `wincode sessions rebuild --all` before reading Session pages."
		);
		const workspaceDeletionState = tx
			.select({
				latestDeletionRevision:
					sessionCatalogDeletionState.latestDeletionRevision,
			})
			.from(sessionCatalogDeletionState)
			.where(eq(sessionCatalogDeletionState.workspaceId, workspaceId))
			.get();
		const maintenance = {
			...projectionMaintenance,
			latestDeletionRevision:
				workspaceDeletionState?.latestDeletionRevision ?? 0,
		};
		const cursor = input.cursor;
		const readPoint = resolveCatalogReadPoint(cursor, workspaceId, maintenance);
		const after =
			cursor === undefined ? undefined : catalogPageAfter(cursor.after);
		const snapshotFilter = and(
			eq(sessionCatalogVersion.workspaceId, workspaceId),
			lte(sessionCatalogVersion.validFromRevision, readPoint.catalogRevision),
			or(
				isSqlNull(sessionCatalogVersion.validToRevision),
				gt(sessionCatalogVersion.validToRevision, readPoint.catalogRevision)
			)
		);
		const rows = tx
			.select()
			.from(sessionCatalogVersion)
			.where(after === undefined ? snapshotFilter : and(snapshotFilter, after))
			.orderBy(
				desc(sessionCatalogVersion.pinned),
				desc(sessionCatalogVersion.lastMessageAt),
				desc(sessionCatalogVersion.createdAt),
				asc(sessionCatalogVersion.sessionId)
			)
			.limit(input.limit + 1)
			.all();
		const selectedRows = rows.slice(0, input.limit);
		const lastRow = selectedRows.at(-1);
		const lastKey =
			lastRow === undefined
				? undefined
				: {
						createdAt: lastRow.createdAt.getTime(),
						lastMessageAt: lastRow.lastMessageAt?.getTime() ?? null,
						pinned: lastRow.pinned,
						sessionId: toSessionId(lastRow.sessionId),
					};
		return {
			hasMore: rows.length > input.limit,
			...(lastKey === undefined ? {} : { lastKey }),
			readPoint,
			sessions: selectedRows.map(toCatalogSession),
		};
	});

type SessionHistoryProjectionCursor = Pick<
	typeof sessionProjectionCursor.$inferSelect,
	"generation" | "logId" | "nextSequence"
>;

type SessionHistoryPageSnapshot = Readonly<{
	readPoint: SessionHistoryReadPoint;
	sessionVersion: typeof sessionCatalogVersion.$inferSelect;
}>;

const assertHistoryCursorScope = (
	cursor: SessionHistoryPageCursor | undefined,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): void => {
	if (
		cursor !== undefined &&
		(cursor.workspaceId !== workspaceId || cursor.sessionId !== sessionId)
	) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session history cursor belongs to a different query scope."
		);
	}
};

const assertHistorySessionBound = (
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	cursor: SessionHistoryPageCursor | undefined
): void => {
	if (sessionIsBoundToWorkspace(operationalDb, workspaceId, sessionId)) {
		return;
	}
	if (cursor !== undefined) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session history cursor expired because the Session is no longer available."
		);
	}
	throw new Error("Session not found");
};

const assertHistoryCursorMatchesMaintenance = (
	cursor: SessionHistoryPageCursor | undefined,
	maintenance: SessionPaginationState
): void => {
	if (cursor === undefined) {
		return;
	}
	if (cursor.projectionId !== maintenance.projectionId) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session history cursor expired after the projection was reset."
		);
	}
	if (cursor.generation !== maintenance.generation) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session history cursor expired after projection maintenance."
		);
	}
	if (cursor.catalogRevision > maintenance.catalogRevision) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session history cursor refers to a future catalog revision."
		);
	}
};

const resolveHistoryProjectionCursor = (
	tx: SessionTransaction,
	sessionId: SessionId,
	generation: number,
	cursor: SessionHistoryPageCursor | undefined
): SessionHistoryProjectionCursor => {
	const projectionCursor = tx
		.select({
			generation: sessionProjectionCursor.generation,
			logId: sessionProjectionCursor.logId,
			nextSequence: sessionProjectionCursor.nextSequence,
		})
		.from(sessionProjectionCursor)
		.where(eq(sessionProjectionCursor.sessionId, sessionId))
		.get();
	if (projectionCursor === undefined) {
		throw new SessionLogError(
			"session_projection_blocked",
			sessionId,
			"Session history has no committed projection cursor."
		);
	}
	if (projectionCursor.generation !== generation) {
		throw new SessionLogError(
			"session_projection_blocked",
			sessionId,
			"Session history projection is stale; retry after projection maintenance."
		);
	}
	if (cursor !== undefined && cursor.logId !== projectionCursor.logId) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session history cursor no longer matches its captured log prefix."
		);
	}
	if (
		cursor !== undefined &&
		cursor.readPointSequence > projectionCursor.nextSequence - 1
	) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session history cursor no longer matches its captured log prefix."
		);
	}
	return projectionCursor;
};

const readHistoryPageSnapshot = (
	tx: SessionTransaction,
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	cursor: SessionHistoryPageCursor | undefined
): SessionHistoryPageSnapshot => {
	const maintenance = requireReadyPaginationMaintenance(
		tx
			.select({
				catalogRevision: sessionProjectionState.catalogRevision,
				generation: sessionProjectionState.generation,
				projectionId: sessionProjectionState.projectionId,
				paginationVersion: sessionProjectionState.paginationVersion,
				status: sessionProjectionState.status,
			})
			.from(sessionProjectionState)
			.where(eq(sessionProjectionState.id, 1))
			.get(),
		[sessionId],
		"Session history projection is unavailable; run `wincode sessions rebuild --all` before reading Session history."
	);
	const currentSession = tx
		.select({ id: session.id })
		.from(session)
		.where(eq(session.id, sessionId))
		.get();
	if (currentSession === undefined) {
		if (cursor !== undefined) {
			throw new SessionPaginationError(
				"cursor_expired",
				"Session history cursor expired because the Session was deleted."
			);
		}
		throw new SessionLogError(
			"session_deleted",
			sessionId,
			"Session not found."
		);
	}
	assertHistoryCursorMatchesMaintenance(cursor, maintenance);
	const projectionCursor = resolveHistoryProjectionCursor(
		tx,
		sessionId,
		maintenance.generation,
		cursor
	);
	const readPoint: SessionHistoryReadPoint =
		cursor === undefined
			? {
					catalogRevision: maintenance.catalogRevision,
					generation: maintenance.generation,
					kind: "history-read-point",
					logId: projectionCursor.logId,
					projectionId: maintenance.projectionId,
					readPointSequence: projectionCursor.nextSequence - 1,
					sessionId,
					version: 1,
					workspaceId,
				}
			: sessionHistoryReadPoint(cursor);
	const sessionVersion = tx
		.select()
		.from(sessionCatalogVersion)
		.where(
			and(
				eq(sessionCatalogVersion.sessionId, sessionId),
				eq(sessionCatalogVersion.generation, readPoint.generation),
				lte(sessionCatalogVersion.validFromRevision, readPoint.catalogRevision),
				or(
					isSqlNull(sessionCatalogVersion.validToRevision),
					gt(sessionCatalogVersion.validToRevision, readPoint.catalogRevision)
				)
			)
		)
		.get();
	if (sessionVersion === undefined) {
		throw new SessionLogError(
			"session_projection_blocked",
			sessionId,
			"Session metadata is missing from the captured projection revision."
		);
	}
	return { readPoint, sessionVersion };
};

const readSessionHistoryPageProjection = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	input: SessionHistoryPageProjectionInput
): SessionHistoryPageProjection => {
	const cursor = input.cursor;
	assertHistoryCursorScope(cursor, workspaceId, sessionId);
	assertHistorySessionBound(operationalDb, workspaceId, sessionId, cursor);
	return db.transaction((tx) => {
		const { readPoint, sessionVersion } = readHistoryPageSnapshot(
			tx,
			workspaceId,
			sessionId,
			cursor
		);
		const beforeSequence = cursor?.beforeSequence;
		const recordFilter = and(
			eq(sessionRecordVersion.sessionId, sessionId),
			lte(sessionRecordVersion.sourceSequence, readPoint.readPointSequence),
			lte(sessionRecordVersion.validFromSequence, readPoint.readPointSequence),
			or(
				isSqlNull(sessionRecordVersion.validToSequence),
				gt(sessionRecordVersion.validToSequence, readPoint.readPointSequence)
			),
			...(beforeSequence === undefined
				? []
				: [lt(sessionRecordVersion.sourceSequence, beforeSequence)])
		);
		const rows = tx
			.select({
				messagesJson: sessionRecordVersion.messagesJson,
				record: sessionRecord,
				sourceSequence: sessionRecordVersion.sourceSequence,
			})
			.from(sessionRecordVersion)
			.innerJoin(
				sessionRecord,
				eq(sessionRecord.recordId, sessionRecordVersion.recordId)
			)
			.where(recordFilter)
			.orderBy(desc(sessionRecordVersion.sourceSequence))
			.limit(input.limit + 1)
			.all();
		const selectedRows = rows.slice(0, input.limit);
		const records = selectedRows
			.toReversed()
			.map(({ messagesJson, record }) =>
				toSessionRecord({ ...record, messagesJson })
			);
		const messageIds = [
			...new Set(
				records.flatMap((record) => record.messages.map(({ id }) => id))
			),
		];
		const compactionsById = new Map<string, SessionCompaction>();
		for (let offset = 0; offset < messageIds.length; offset += 500) {
			const chunk = messageIds.slice(offset, offset + 500);
			const compactionRows = tx
				.select({ compaction: sessionCompaction })
				.from(sessionCompaction)
				.where(
					and(
						eq(sessionCompaction.sessionId, sessionId),
						lte(sessionCompaction.sourceSequence, readPoint.readPointSequence),
						inArray(sessionCompaction.throughMessageUiId, chunk)
					)
				)
				.orderBy(asc(sessionCompaction.sequence))
				.all();
			for (const { compaction } of compactionRows) {
				compactionsById.set(compaction.id, toSessionCompaction(compaction));
			}
		}
		const selectedOldest = selectedRows.at(-1);
		return {
			...(selectedRows.length === 0 || selectedOldest === undefined
				? {}
				: { beforeSequence: selectedOldest.sourceSequence }),
			compactions: [...compactionsById.values()].sort(
				(left, right) => left.sequence - right.sequence
			),
			hasMore: rows.length > input.limit,
			readPoint,
			records,
			session: toCatalogSession(sessionVersion),
		};
	});
};

const assertStatisticsSessionAvailable = (
	tx: SessionTransaction,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	readPoint?: SessionHistoryReadPoint
): void => {
	const available =
		sessionIsBoundToWorkspace(operationalDb, workspaceId, sessionId) &&
		tx
			.select({ id: session.id })
			.from(session)
			.where(eq(session.id, sessionId))
			.get() !== undefined;
	if (available) {
		return;
	}
	if (readPoint !== undefined) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session statistics read point expired because the Session is no longer available."
		);
	}
	throw new SessionLogError("session_deleted", sessionId, "Session not found.");
};

const resolveSessionStatisticsReadPoint = (
	tx: SessionTransaction,
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	maintenance: SessionPaginationState,
	requestedReadPoint?: SessionHistoryReadPoint
): SessionHistoryReadPoint => {
	const projectionCursor = tx
		.select({
			generation: sessionProjectionCursor.generation,
			logId: sessionProjectionCursor.logId,
			nextSequence: sessionProjectionCursor.nextSequence,
		})
		.from(sessionProjectionCursor)
		.where(eq(sessionProjectionCursor.sessionId, sessionId))
		.get();
	if (
		projectionCursor === undefined ||
		projectionCursor.generation !== maintenance.generation
	) {
		throw new SessionLogError(
			"session_projection_blocked",
			sessionId,
			"Session statistics projection is stale; retry after projection maintenance."
		);
	}
	if (requestedReadPoint === undefined) {
		return {
			catalogRevision: maintenance.catalogRevision,
			generation: maintenance.generation,
			kind: "history-read-point",
			logId: projectionCursor.logId,
			projectionId: maintenance.projectionId,
			readPointSequence: projectionCursor.nextSequence - 1,
			sessionId,
			version: 1,
			workspaceId,
		};
	}
	if (
		requestedReadPoint.sessionId !== sessionId ||
		requestedReadPoint.workspaceId !== workspaceId
	) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session statistics read point belongs to a different query scope."
		);
	}
	if (
		requestedReadPoint.projectionId !== maintenance.projectionId ||
		requestedReadPoint.generation !== maintenance.generation ||
		requestedReadPoint.logId !== projectionCursor.logId
	) {
		throw new SessionPaginationError(
			"cursor_expired",
			"Session statistics read point expired after projection maintenance or log replacement."
		);
	}
	if (
		requestedReadPoint.catalogRevision > maintenance.catalogRevision ||
		requestedReadPoint.readPointSequence > projectionCursor.nextSequence - 1
	) {
		throw new SessionPaginationError(
			"cursor_invalid",
			"Session statistics read point refers to a future projection prefix."
		);
	}
	return requestedReadPoint;
};

const readSessionStatisticsProjection = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	requestedReadPoint?: SessionHistoryReadPoint
): SessionStatisticsProjection =>
	db.transaction((tx) => {
		const maintenance = requireReadyPaginationMaintenance(
			tx
				.select({
					catalogRevision: sessionProjectionState.catalogRevision,
					generation: sessionProjectionState.generation,
					projectionId: sessionProjectionState.projectionId,
					paginationVersion: sessionProjectionState.paginationVersion,
					status: sessionProjectionState.status,
				})
				.from(sessionProjectionState)
				.where(eq(sessionProjectionState.id, 1))
				.get(),
			[sessionId],
			"Session statistics projection is unavailable; run `wincode sessions rebuild --all` before reading Session statistics."
		);
		assertStatisticsSessionAvailable(
			tx,
			operationalDb,
			workspaceId,
			sessionId,
			requestedReadPoint
		);
		const readPoint = resolveSessionStatisticsReadPoint(
			tx,
			workspaceId,
			sessionId,
			maintenance,
			requestedReadPoint
		);
		const recordRows = tx
			.select({
				messagesJson: sessionRecordVersion.messagesJson,
				record: sessionRecord,
			})
			.from(sessionRecordVersion)
			.innerJoin(
				sessionRecord,
				eq(sessionRecord.recordId, sessionRecordVersion.recordId)
			)
			.where(
				and(
					eq(sessionRecordVersion.sessionId, sessionId),
					lte(sessionRecordVersion.sourceSequence, readPoint.readPointSequence),
					lte(
						sessionRecordVersion.validFromSequence,
						readPoint.readPointSequence
					),
					or(
						isSqlNull(sessionRecordVersion.validToSequence),
						gt(
							sessionRecordVersion.validToSequence,
							readPoint.readPointSequence
						)
					)
				)
			)
			.orderBy(asc(sessionRecordVersion.sourceSequence))
			.all();
		const compactionRows = tx
			.select({ compaction: sessionCompaction })
			.from(sessionCompaction)
			.where(
				and(
					eq(sessionCompaction.sessionId, sessionId),
					lte(sessionCompaction.sourceSequence, readPoint.readPointSequence)
				)
			)
			.orderBy(asc(sessionCompaction.sequence))
			.all();
		const usageEntryRows = tx
			.select()
			.from(sessionUsageEntry)
			.where(
				and(
					eq(sessionUsageEntry.sessionId, sessionId),
					lte(sessionUsageEntry.sourceSequence, readPoint.readPointSequence)
				)
			)
			.orderBy(asc(sessionUsageEntry.sourceSequence))
			.all();
		return {
			compactions: compactionRows.map(({ compaction }) =>
				toSessionCompaction(compaction)
			),
			readPoint,
			records: recordRows.map(({ messagesJson, record }) =>
				toSessionRecord({ ...record, messagesJson })
			),
			usageEntries: usageEntryRows.map(toSessionUsageEntry),
		};
	});

export type DrizzleSessionStore = SessionProjectionStore &
	Readonly<{
		assertResetAllowed: () => Promise<void>;
		jsonlProjection: SessionJsonlProjection;
		markSessionDeleted: (sessionId: SessionId) => void;
		readSessionCatalogPageProjection: (
			input: SessionCatalogPageProjectionInput
		) => SessionCatalogPageProjection;
		readSessionHistoryPageProjection: (
			sessionId: SessionId,
			input: SessionHistoryPageProjectionInput
		) => SessionHistoryPageProjection;
		readSessionStatisticsProjection: (
			sessionId: SessionId,
			readPoint?: SessionHistoryReadPoint
		) => SessionStatisticsProjection;
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
			lifecycleRoot: sessionLogRoot,
			repository: createDrizzleAttachmentMetadataRepository(operationalDb),
			root: attachmentRoot,
		});
	const externalizeAttachments = (
		messages: readonly SessionMessage[],
		signal?: AbortSignal,
		externalizationOptions?: AttachmentExternalizationOptions
	): Promise<AttachmentExternalizationLease> =>
		attachmentStore
			? attachmentStore.externalizeMessagesWithLease(
					messages,
					signal,
					externalizationOptions
				)
			: Promise.resolve({
					messages: [...messages],
					release: async () => undefined,
				});
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
					liveAttachmentIds: () => collectLiveAttachmentIds(operationalDb),
					safetyWindowMs,
				})
			: {
					orphanBytes: 0,
					orphanCount: 0,
					reclaimedBytes: 0,
					reclaimedCount: 0,
				};
	};
	const markSessionDeleted = (sessionId: SessionId): void => {
		const binding = operationalDb
			.select({ workspaceId: localSessionBinding.workspaceId })
			.from(localSessionBinding)
			.where(eq(localSessionBinding.sessionId, sessionId))
			.get();
		if (binding?.workspaceId !== workspace.id) {
			return;
		}
		const hasProjectedSession = db.transaction((tx) => {
			const projected = tx
				.select({ id: session.id })
				.from(session)
				.where(eq(session.id, sessionId))
				.get();
			if (projected === undefined) {
				return false;
			}
			recordDeletionCursorInvalidation(tx, workspace.id);
			return true;
		});
		if (hasProjectedSession) {
			db.delete(session).where(eq(session.id, sessionId)).run();
		}
	};
	const assertResetAllowed = async (): Promise<void> => {
		const workspaceIds = operationalDb
			.select({ id: sessionWorkspace.id })
			.from(sessionWorkspace)
			.all()
			.map(({ id }) => id)
			.sort();
		for (const workspaceId of workspaceIds) {
			const recovery = createDrizzleRecoveryStore(
				operationalDb,
				snapshotRoot,
				workspaceId
			);
			await recovery.ensureReady?.();
			if ((await recovery.listUnresolvedRecoveries()).length > 0) {
				throw new Error(
					"Reset is blocked until every workspace recovery is reconciled or discarded."
				);
			}
		}
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
		assertResetAllowed,
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

		markSessionDeleted,
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
			if (binding !== undefined) {
				markSessionDeleted(sessionId);
				operationalDb
					.delete(localSessionBinding)
					.where(eq(localSessionBinding.sessionId, sessionId))
					.run();
			}
			await collectAttachments();
			const prune = fileObservationStore.pruneSnapshots;
			if (prune) {
				await prune().catch(() => undefined);
			}
		},
		resetSessionData: async () => {
			await assertResetAllowed();
			db.transaction((tx) => {
				const currentState = tx
					.select({ generation: sessionProjectionState.generation })
					.from(sessionProjectionState)
					.where(eq(sessionProjectionState.id, 1))
					.get();
				if (
					currentState === undefined ||
					!Number.isSafeInteger(currentState.generation + 1)
				) {
					throw new Error("Session projection generation is unavailable.");
				}
				tx.delete(sessionCompaction).run();
				tx.delete(sessionRecord).run();
				tx.delete(sessionUsageEntry).run();
				tx.delete(session).run();
				tx.delete(sessionProjectionCursor).run();
				tx.delete(sessionCatalogDeletionState).run();
				tx.update(sessionProjectionState)
					.set({
						catalogRevision: 0,
						generation: currentState.generation + 1,
						latestDeletionRevision: 0,
						paginationVersion: 2,
						status: "ready",
					})
					.where(eq(sessionProjectionState.id, 1))
					.run();
			});
			operationalDb.transaction((tx) => {
				tx.delete(localSessionBinding).run();
			});
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
		readSessionHistoryPageProjection: (sessionId, input) =>
			readSessionHistoryPageProjection(
				db,
				operationalDb,
				workspace.id,
				sessionId,
				input
			),
		readSessionStatisticsProjection: (sessionId, readPoint) =>
			readSessionStatisticsProjection(
				db,
				operationalDb,
				workspace.id,
				sessionId,
				readPoint
			),
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
		readSessionCatalogPageProjection: (input) =>
			readSessionCatalogPageProjection(db, workspace.id, input),
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
