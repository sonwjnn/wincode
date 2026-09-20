import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	agentIdSchema,
	isAgentTurnDelegation,
	isSessionAttachmentReferencePart,
	SESSION_RECORD_VERSION,
	type SessionRecord,
	type SessionRecordId,
	toAgentTurnId,
	toSessionMessageId,
	toSessionRecordId,
} from "@wincode/agent-core";
import {
	type ChatModelSelection,
	modelSelectionSchema,
} from "@wincode/ai/models";
import type { EditMode } from "@wincode/coding-tools";
import {
	isArray,
	isNull,
	isUndefined,
	omitUndefined,
	pickTruthy,
} from "@wincode/runtime-utils";
import { randomUUIDv7 } from "bun";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
	type CompactionId,
	type SessionId,
	toCompactionId,
	toSessionId,
	toWorkspaceId,
	type WorkspaceId,
} from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type { SessionMessage } from "../message";
import type {
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	SessionAttachmentStore,
} from "./attachment-store";
import {
	attachmentIdSchema,
	attachmentReferenceSchema,
	createDrizzleAttachmentMetadataRepository,
	createSessionAttachmentStore,
	getAttachmentReference,
	isLegacyImagePart,
} from "./attachment-store";
import { createDatabase, type SessionDatabase } from "./client";
import { resolveLocalAttachmentRoot, resolveLocalSnapshotRoot } from "./path";
import {
	promptHistory,
	type SerializedJson,
	session,
	sessionAttachment,
	sessionCompaction,
	sessionRecord,
	sessionWorkspace,
} from "./schema";
import {
	getSessionRecordValidationError,
	SessionRecordInvariantError,
	toDurableSessionMessageRecord,
} from "./session-record";
import {
	type CommitSessionRecordInput,
	type CreateSessionInput,
	type PromptHistoryEntry,
	type Session,
	type SessionStore,
	UNTITLED_SESSION_TITLE,
	type UpdateSessionInput,
} from "./session-store";
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
		.array(z.object({ text: z.string(), token: z.string() }))
		.optional(),
});

const parsePromptHistoryEntry = (
	entry: unknown,
	text: string
): PromptHistoryEntry => ({
	...promptHistoryEntrySchema.parse(entry ?? { files: [] }),
	text,
});

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
	formatVersion: z.literal(1),
	focus: z.string().optional(),
	text: z.string(),
});

const parseCompactionSummary = (value: unknown): SessionCompaction["summary"] =>
	compactionSummarySchema.parse(value);

const clearAttachmentRoot = async (root: string): Promise<void> => {
	await mkdir(root, { recursive: true });
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		await rm(join(root, entry.name), { force: true, recursive: true });
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
			JSON.stringify(entry.fileTokens ?? [])
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

const toSessionCompaction = (row: CompactionRow): SessionCompaction => {
	const summarizationModel = modelSelectionSchema.parse(
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
		summarizationVariant: row.summarizationVariant ?? undefined,
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
	snapshotRoot?: string;
	workspaceRoot?: string;
};

const hashWorkspace = (rootPath: string): string =>
	createHash("sha256").update(rootPath).digest("hex").slice(0, 16);

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
	const parsedModel = row.modelJson
		? modelSelectionSchema.safeParse(row.modelJson)
		: undefined;
	return {
		createdAt: row.createdAt,
		id: toSessionId(row.id),
		lastMessageAt: row.lastMessageAt ?? null,
		...omitUndefined({ model: parsedModel?.data }),
		pinned: row.pinned,
		title: row.title ?? UNTITLED_SESSION_TITLE,
		...pickTruthy({ variant: row.variant ?? undefined }),
	};
};
const toSessionRecordModel = (
	model: Pick<SessionRecord["model"], "modelId" | "providerId">,
	variant: SessionRecord["model"]["variant"]
): SessionRecord["model"] => ({
	modelId: model.modelId,
	providerId: model.providerId,
	...omitUndefined({ variant }),
});
const toSessionRecord = (row: SessionRecordRow): SessionRecord => {
	let delegation: SessionRecord["delegation"];
	if (!isNull(row.delegationJson)) {
		if (!isAgentTurnDelegation(row.delegationJson)) {
			throw new SessionRecordInvariantError(
				"Invalid persisted Session Record delegation."
			);
		}
		delegation = row.delegationJson;
	}
	const record = {
		agentId: agentIdSchema.parse(row.agentId),
		...omitUndefined({ delegation }),
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

const collectLiveAttachmentIds = (db: SessionDatabase): Set<string> => {
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
	db: SessionDatabase,
	workspaceId: WorkspaceId,
	input: AppendSessionCompactionInput
): SessionCompaction =>
	db.transaction((tx) => {
		const sessionRow = tx
			.select({ id: session.id })
			.from(session)
			.where(
				and(
					eq(session.id, input.sessionId),
					eq(session.workspaceId, workspaceId)
				)
			)
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
			summarizationVariant: input.summarizationVariant ?? null,
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

const writeSessionRecordCheckpoint = (
	db: SessionDatabase,
	workspaceId: WorkspaceId,
	{ sessionModel, sessionVariant, record, sessionId }: CommitSessionRecordInput
): void => {
	const validationError = getSessionRecordValidationError(record);
	if (!isNull(validationError)) {
		throw new SessionRecordInvariantError(
			`Invalid Session Record: ${validationError}`,
			{ cause: new Error(validationError) }
		);
	}
	const modelJson = serializeJson(
		toSessionRecordModel(record.model, record.model.variant)
	);
	db.transaction((tx) => {
		const sessionRow = tx
			.select({ id: session.id })
			.from(session)
			.where(
				and(eq(session.id, sessionId), eq(session.workspaceId, workspaceId))
			)
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
			delegationJson: serializeJson(record.delegation ?? null),
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
							variant: sessionVariant ?? null,
						}),
				updatedAt: now,
			})
			.where(
				and(eq(session.id, sessionId), eq(session.workspaceId, workspaceId))
			)
			.run();
	});
};

const readSessionRecordRows = (
	db: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): SessionRecordRow[] =>
	db
		.select({ record: sessionRecord })
		.from(sessionRecord)
		.innerJoin(session, eq(sessionRecord.sessionId, session.id))
		.where(
			and(
				eq(sessionRecord.sessionId, sessionId),
				eq(session.workspaceId, workspaceId)
			)
		)
		.orderBy(asc(sessionRecord.position))
		.all()
		.map(({ record }) => record);

const readSessionRecords = (
	db: SessionDatabase,
	workspaceId: WorkspaceId,
	sessionId: SessionId
): SessionRecord[] =>
	readSessionRecordRows(db, workspaceId, sessionId).map(toSessionRecord);

export const createDrizzleSessionStore = (
	database?: SessionDatabase,
	options: DrizzleSessionStoreOptions = {}
): SessionStore => {
	const db = database ?? createDatabase().db;

	const attachmentRoot = options.attachmentRoot ?? resolveLocalAttachmentRoot();
	const snapshotRoot = options.snapshotRoot ?? resolveLocalSnapshotRoot();
	const attachmentStore =
		options.attachmentStore ??
		createSessionAttachmentStore({
			repository: createDrizzleAttachmentMetadataRepository(db),
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
	const promptHistoryStore = createPromptHistory(db, attachmentStore);
	const workspace = ensureWorkspace(db, options.workspaceRoot ?? process.cwd());
	const fileObservationStore = createDrizzleFileObservationStore(
		db,
		snapshotRoot
	);
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
			const durableMessage = toDurableSessionMessageRecord(message);
			if (isUndefined(durableMessage) || durableMessage.role !== "user") {
				throw new Error("Initial session message has no durable parts.");
			}
			const id = createSessionId();
			const now = new Date();
			const recordModel = toSessionRecordModel(
				message.metadata?.model ?? model,
				message.metadata?.variant ?? variant
			);

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
						variant,
						workspaceId: workspace.id,
					})
					.run();
				tx.insert(sessionRecord)
					.values({
						agentId: agent,
						createdAt: now,
						delegationJson: null,
						messagesJson: serializeJson([durableMessage]),
						modelJson: serializeJson(recordModel),
						outcomeJson: serializeJson({ kind: "user" }),
						position: 0,
						recordId: createSessionRecordId(),
						sessionId: id,
						turnId,
						version: SESSION_RECORD_VERSION,
					})
					.run();
			});

			return { id };
		},

		deleteSession: async (sessionId: SessionId) => {
			db.delete(session)
				.where(
					and(eq(session.id, sessionId), eq(session.workspaceId, workspace.id))
				)
				.run();
			await collectAttachments().catch(() => undefined);
			const prune = fileObservationStore.pruneSnapshots;
			if (prune) {
				await prune().catch(() => undefined);
			}
		},

		resetSessionData: async () => {
			db.transaction((tx) => {
				tx.delete(sessionCompaction).run();
				tx.delete(sessionRecord).run();
				tx.delete(session).run();
				tx.delete(sessionAttachment).run();
			});
			await clearAttachmentRoot(attachmentRoot);
			const prune = fileObservationStore.pruneSnapshots;
			if (prune) {
				await prune().catch(() => undefined);
			}
		},

		getCompactions: (sessionId: SessionId) => {
			const rows = db
				.select({
					compaction: sessionCompaction,
				})
				.from(sessionCompaction)
				.innerJoin(session, eq(sessionCompaction.sessionId, session.id))
				.where(
					and(
						eq(sessionCompaction.sessionId, sessionId),
						eq(session.workspaceId, workspace.id)
					)
				)
				.orderBy(asc(sessionCompaction.sequence))
				.all();
			return Promise.resolve(
				rows.map(({ compaction }) => toSessionCompaction(compaction))
			);
		},

		getLatestCompaction: (sessionId: SessionId) => {
			const row = db
				.select({
					compaction: sessionCompaction,
				})
				.from(sessionCompaction)
				.innerJoin(session, eq(sessionCompaction.sessionId, session.id))
				.where(
					and(
						eq(sessionCompaction.sessionId, sessionId),
						eq(session.workspaceId, workspace.id)
					)
				)
				.orderBy(desc(sessionCompaction.sequence))
				.limit(1)
				.get();
			return Promise.resolve(row ? toSessionCompaction(row.compaction) : null);
		},

		commitSessionRecord: async ({
			sessionModel,
			sessionVariant,
			record,
			sessionId,
		}) => {
			writeSessionRecordCheckpoint(db, workspace.id, {
				sessionModel,
				sessionVariant,
				record,
				sessionId,
			});
		},
		listSessionRecords: async (sessionId: SessionId) =>
			readSessionRecords(db, workspace.id, sessionId),
		getSession: (sessionId: SessionId) => {
			const row = db
				.select()
				.from(session)
				.where(
					and(eq(session.id, sessionId), eq(session.workspaceId, workspace.id))
				)
				.get();

			if (!row) {
				return Promise.reject(new Error("Session not found"));
			}

			return Promise.resolve(toSession(row));
		},
		getEditMode: async (sessionId: SessionId): Promise<EditMode> => {
			const row = db
				.select({ editMode: session.editMode })
				.from(session)
				.where(
					and(eq(session.id, sessionId), eq(session.workspaceId, workspace.id))
				)
				.get();
			return row?.editMode ?? "hashline";
		},
		setEditMode: async (sessionId: SessionId, mode: EditMode) => {
			db.update(session)
				.set({ editMode: mode, updatedAt: new Date() })
				.where(
					and(eq(session.id, sessionId), eq(session.workspaceId, workspace.id))
				)
				.run();
		},
		listSessions: () => {
			const rows = db
				.select()
				.from(session)
				.where(eq(session.workspaceId, workspace.id))
				.orderBy(
					desc(session.pinned),
					desc(session.lastMessageAt),
					desc(session.createdAt)
				)
				.all();

			return Promise.resolve(rows.map(toSession));
		},
		listRecentModelSelections: (limit: number) => {
			if (limit <= 0) {
				return [];
			}
			const rows = db
				.select({
					createdAt: sessionRecord.createdAt,
					model: sessionRecord.modelJson,
				})
				.from(sessionRecord)
				.innerJoin(session, eq(sessionRecord.sessionId, session.id))
				.where(eq(session.workspaceId, workspace.id))
				.orderBy(desc(sessionRecord.createdAt))
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

		updateSession: (sessionId: SessionId, data: UpdateSessionInput) => {
			db.update(session)
				.set({
					updatedAt: new Date(),
					...omitUndefined({ title: data.title, pinned: data.pinned }),
				})
				.where(
					and(eq(session.id, sessionId), eq(session.workspaceId, workspace.id))
				)
				.run();

			return Promise.resolve();
		},
		fileObservationStore,
		attachmentStore,
		externalizeAttachments,
		hydrateAttachments,
		collectAttachments,
	};
};
