import {
	agentIdSchema,
	isSessionToolCallPart,
	type SessionRecord,
	toAgentTurnId,
	toSessionMessageId,
	toSessionRecordId,
	toSubmissionId,
} from "@wincode/agent-core";
import { modelUsageSchema, thinkingLevelSchema } from "@wincode/ai";
import { isNull, omitUndefined } from "@wincode/utils";
import { and, desc, eq, isNull as isSqlNull } from "drizzle-orm";
import {
	type ProviderModelSelection,
	providerModelSelectionSchema,
} from "@/modules/providers/provider-model-selection";
import type { EditMode } from "@/modules/tools";
import {
	type SessionId,
	toCompactionId,
	toSessionId,
	toSessionUsageEntryId,
	type WorkspaceId,
} from "@/shared/identifiers";
import type { SessionCompaction } from "../compaction/types";
import { assertCompactionMessageReferences } from "../compaction/validation";
import { sessionContextEditSchema } from "../context-edits";
import { withSubmissionStatus } from "../message";
import type { SessionDatabase } from "./client";
import type { SerializedJson } from "./schema";
import {
	localSessionBinding,
	session,
	sessionCatalogDeletionState,
	sessionCatalogVersion,
	sessionCompaction,
	sessionContextEdit,
	sessionForkProvenance,
	sessionOperationLookup,
	sessionProjectionCursor,
	sessionProjectionState,
	sessionRecord,
	sessionRecordMessageIdentity,
	sessionRecordToolCall,
	sessionRecordVersion,
	sessionUsageEntry,
} from "./schema";
import {
	parseSessionCompactionPayload,
	parseSessionForkedPayload,
	type SessionCompactionPayload,
	type SessionJsonlProjection,
	type SessionLogEntry,
	type SessionLogEnvelope,
	SessionLogError,
	type SessionProjectionMaintenanceState,
	sessionLogOperationDigest,
	sessionProjectionCursorsEqual,
} from "./session-jsonl-codec";
import { getSessionRecordValidationError } from "./session-record";

const serializeJson = <Value>(value: Value): SerializedJson<Value> =>
	JSON.parse(JSON.stringify(value)) as SerializedJson<Value>;

const asRecord = (entry: SessionLogEntry): SessionRecord | undefined => {
	if (entry.envelope.type === "record.committed") {
		return entry.envelope.payload.record as SessionRecord;
	}
	if (entry.envelope.type === "session.created") {
		return entry.envelope.payload.initialRecord as SessionRecord | undefined;
	}
};

const assertProjectionMaintenanceMode = (
	status: string,
	mode: "append" | "replace" | "maintenance"
): void => {
	if (
		(status === "rebuilding" && mode !== "maintenance") ||
		(status !== "rebuilding" && mode === "maintenance")
	) {
		throw new Error("Session projection maintenance mode changed.");
	}
};

type SessionProjectionTransaction = Parameters<
	SessionDatabase["transaction"]
>[0] extends (transaction: infer Transaction) => unknown
	? Transaction
	: never;

const bindSessionProjectionWorkspace = (
	operationalDb: SessionDatabase,
	sessionId: SessionId,
	workspaceId: WorkspaceId,
	mode: "append" | "replace" | "maintenance"
): string => {
	const binding = operationalDb
		.select({ workspaceId: localSessionBinding.workspaceId })
		.from(localSessionBinding)
		.where(eq(localSessionBinding.sessionId, sessionId))
		.get();
	const targetWorkspaceId =
		mode !== "append" && binding !== undefined
			? binding.workspaceId
			: workspaceId;
	if (binding === undefined) {
		operationalDb
			.insert(localSessionBinding)
			.values({ sessionId, workspaceId })
			.run();
	} else if (binding.workspaceId !== targetWorkspaceId) {
		throw new Error("Session is already bound to another workspace.");
	}
	return targetWorkspaceId;
};

const projectSessionRecordMessageIdentities = (
	tx: SessionProjectionTransaction,
	sessionId: SessionId,
	record: SessionRecord
): string[] => {
	const joinedTurnIds: string[] = [];
	for (const message of record.messages) {
		const sourceUserMessageId = message.metadata?.sourceUserMessageId;
		if (sourceUserMessageId !== undefined) {
			const sourceMessage = tx
				.select({ role: sessionRecordMessageIdentity.role })
				.from(sessionRecordMessageIdentity)
				.where(
					and(
						eq(sessionRecordMessageIdentity.sessionId, sessionId),
						eq(
							sessionRecordMessageIdentity.messageId,
							String(sourceUserMessageId)
						)
					)
				)
				.get();
			if (sourceMessage?.role !== "user") {
				throw new Error(
					"Session Record context refers to a missing source User Message."
				);
			}
		}
		const joinedTurnId = message.metadata?.joinedTurnId;
		if (joinedTurnId !== undefined) {
			joinedTurnIds.push(String(joinedTurnId));
		}
		tx.insert(sessionRecordMessageIdentity)
			.values({
				messageId: String(message.id),
				recordId: record.id,
				role: message.role,
				sessionId,
				submissionId:
					message.role === "user"
						? (message.metadata?.submissionId ?? null)
						: null,
			})
			.run();
	}
	return joinedTurnIds;
};

const assertProjectionOperationIdIsNew = (
	tx: SessionProjectionTransaction,
	sessionId: SessionId,
	envelope: SessionLogEnvelope
): void => {
	if (
		envelope.type === "session.header" ||
		envelope.type === "session.deleted"
	) {
		return;
	}
	const existing = tx
		.select({ operationId: sessionOperationLookup.operationId })
		.from(sessionOperationLookup)
		.where(
			and(
				eq(sessionOperationLookup.sessionId, sessionId),
				eq(sessionOperationLookup.operationId, envelope.operationId)
			)
		)
		.get();
	if (existing !== undefined) {
		throw new Error("Session log repeats a committed operation identity.");
	}
};

const assertProjectedCompactionChain = (
	tx: SessionProjectionTransaction,
	sessionId: SessionId,
	payload: SessionCompactionPayload
): void => {
	const previous = tx
		.select({ id: sessionCompaction.id, sequence: sessionCompaction.sequence })
		.from(sessionCompaction)
		.where(eq(sessionCompaction.sessionId, sessionId))
		.orderBy(desc(sessionCompaction.sequence))
		.limit(1)
		.get();
	const existingId = tx
		.select({ id: sessionCompaction.id })
		.from(sessionCompaction)
		.where(eq(sessionCompaction.id, toCompactionId(payload.id)))
		.get();
	if (
		payload.sequence !== (previous?.sequence ?? 0) + 1 ||
		payload.priorCompactionId !== (previous?.id ?? null) ||
		existingId !== undefined
	) {
		throw new Error("Session log contains a broken compaction identity chain.");
	}
};

const projectedCompactionMessageIds = (
	tx: SessionProjectionTransaction,
	sessionId: SessionId,
	messageIds: readonly string[]
): Set<SessionRecord["messages"][number]["id"]> => {
	const availableMessageIds = new Set<
		SessionRecord["messages"][number]["id"]
	>();
	for (const messageId of new Set(messageIds)) {
		const message = tx
			.select({ messageId: sessionRecordMessageIdentity.messageId })
			.from(sessionRecordMessageIdentity)
			.where(
				and(
					eq(sessionRecordMessageIdentity.sessionId, sessionId),
					eq(sessionRecordMessageIdentity.messageId, messageId)
				)
			)
			.get();
		if (message !== undefined) {
			availableMessageIds.add(toSessionMessageId(message.messageId));
		}
	}
	return availableMessageIds;
};

const assertProjectionEntryIsSafe = (
	tx: SessionProjectionTransaction,
	sessionId: SessionId,
	envelope: SessionLogEnvelope
): void => {
	if (envelope.sessionId !== sessionId) {
		throw new Error("Session log projection contains a foreign entry.");
	}
	assertProjectionOperationIdIsNew(tx, sessionId, envelope);
};

const assertJoinedTurnReferencesExist = (
	tx: SessionProjectionTransaction,
	sessionId: SessionId,
	turnIds: readonly string[]
): void => {
	for (const turnId of turnIds) {
		const joinedTurn = tx
			.select({ turnId: sessionRecord.turnId })
			.from(sessionRecord)
			.where(
				and(
					eq(sessionRecord.sessionId, sessionId),
					eq(sessionRecord.turnId, turnId)
				)
			)
			.limit(1)
			.get();
		if (joinedTurn === undefined) {
			throw new Error(
				"Session Record context refers to a missing joined Agent Turn."
			);
		}
	}
};

const projectRecordToolCalls = (
	tx: SessionProjectionTransaction,
	sessionId: SessionId,
	record: SessionRecord,
	sourceSequence: number
): void => {
	const toolCallIds = new Set(
		record.messages.flatMap((message) =>
			message.parts.flatMap((part) =>
				isSessionToolCallPart(part) ? [part.toolCallId] : []
			)
		)
	);
	for (const toolCallId of toolCallIds) {
		tx.insert(sessionRecordToolCall)
			.values({
				sessionId,
				sourceSequence,
				toolCallId,
				turnId: record.turnId,
			})
			.onConflictDoNothing()
			.run();
	}
};

const projectionStateExists = (db: SessionDatabase): boolean =>
	db
		.select({ id: sessionProjectionState.id })
		.from(sessionProjectionState)
		.where(eq(sessionProjectionState.id, 1))
		.get() !== undefined;

export class SessionProjectionUnavailableError extends Error {
	readonly code = "session_projection_unavailable" as const;

	constructor(cause: unknown) {
		super(
			"The Session projection cannot be initialized. Make the projection database writable, or clear local Session data with `wincode db:reset-sessions`.",
			{ cause }
		);
		this.name = "SessionProjectionUnavailableError";
	}
}

export const createSessionJsonlProjection = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId
): SessionJsonlProjection => {
	// A projection that already carries state must open for reads even when its
	// file is not writable; a later commit then reports committed/blocked.
	if (!projectionStateExists(db)) {
		try {
			db.insert(sessionProjectionState)
				.values({
					id: 1,
					projectionId: crypto.randomUUID(),
					generation: 0,
					statisticsVersion: 1,
					status: "ready",
				})
				.onConflictDoNothing()
				.run();
		} catch (error) {
			throw new SessionProjectionUnavailableError(error);
		}
	}
	return {
		workspaceId,
		bindSessionToWorkspace: (sessionId) => {
			const binding = operationalDb
				.select({ workspaceId: localSessionBinding.workspaceId })
				.from(localSessionBinding)
				.where(eq(localSessionBinding.sessionId, sessionId))
				.get();
			if (binding === undefined) {
				operationalDb
					.insert(localSessionBinding)
					.values({ sessionId, workspaceId })
					.run();
			} else if (binding.workspaceId !== workspaceId) {
				throw new Error("Session is already bound to another workspace.");
			}
		},
		beginRebuild: () =>
			db.transaction((tx) => {
				const current = tx
					.select()
					.from(sessionProjectionState)
					.where(eq(sessionProjectionState.id, 1))
					.get();
				if (
					current === undefined ||
					!Number.isSafeInteger(current.generation + 1)
				) {
					throw new Error("Session projection generation is unavailable.");
				}
				const generation = current.generation + 1;
				tx.update(sessionProjectionState)
					.set({ generation, status: "rebuilding" })
					.where(eq(sessionProjectionState.id, 1))
					.run();
				return generation;
			}),
		completeRebuild: (generation, completesStatisticsRebuild) =>
			db.transaction((tx) => {
				const current = tx
					.select()
					.from(sessionProjectionState)
					.where(eq(sessionProjectionState.id, 1))
					.get();
				if (
					current === undefined ||
					current.generation !== generation ||
					current.status !== "rebuilding"
				) {
					throw new Error("Session projection rebuild generation changed.");
				}
				tx.update(sessionProjectionState)
					.set({
						paginationVersion: 2,
						...(completesStatisticsRebuild ? { statisticsVersion: 1 } : {}),
						status: "ready",
					})
					.where(
						and(
							eq(sessionProjectionState.id, 1),
							eq(sessionProjectionState.generation, generation),
							eq(sessionProjectionState.status, "rebuilding")
						)
					)
					.run();
			}),
		getMaintenanceState: (): SessionProjectionMaintenanceState => {
			const row = db
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
				.get();
			if (row === undefined) {
				throw new Error("Session projection maintenance state is missing.");
			}
			return row;
		},
		getCursor: (sessionId) => {
			const row = db
				.select({
					generation: sessionProjectionCursor.generation,
					lastHash: sessionProjectionCursor.lastHash,
					logId: sessionProjectionCursor.logId,
					nextByteOffset: sessionProjectionCursor.nextByteOffset,
					nextSequence: sessionProjectionCursor.nextSequence,
				})
				.from(sessionProjectionCursor)
				.where(eq(sessionProjectionCursor.sessionId, sessionId))
				.get();
			return row;
		},
		isSessionImportActivationConfirmed: (sessionId) =>
			db
				.select({ operationId: sessionOperationLookup.operationId })
				.from(sessionOperationLookup)
				.where(
					and(
						eq(sessionOperationLookup.sessionId, sessionId),
						eq(sessionOperationLookup.type, "session.activation-confirmed")
					)
				)
				.limit(1)
				.get() !== undefined,
		isBoundToAnotherWorkspace: (sessionId) => {
			const binding = operationalDb
				.select({ workspaceId: localSessionBinding.workspaceId })
				.from(localSessionBinding)
				.where(eq(localSessionBinding.sessionId, sessionId))
				.get();
			return binding !== undefined && binding.workspaceId !== workspaceId;
		},
		isBoundToWorkspace: (sessionId) => {
			const binding = operationalDb
				.select({ workspaceId: localSessionBinding.workspaceId })
				.from(localSessionBinding)
				.where(eq(localSessionBinding.sessionId, sessionId))
				.get();
			return binding?.workspaceId === workspaceId;
		},
		listAllBoundSessionIds: () =>
			operationalDb
				.select({ sessionId: localSessionBinding.sessionId })
				.from(localSessionBinding)
				.all()
				.map(({ sessionId }) => toSessionId(sessionId))
				.sort(),
		listBoundSessionIds: () =>
			operationalDb
				.select({ sessionId: localSessionBinding.sessionId })
				.from(localSessionBinding)
				.where(eq(localSessionBinding.workspaceId, workspaceId))
				.all()
				.map(({ sessionId }) => toSessionId(sessionId))
				.sort(),
		listSessionIds: () =>
			db
				.select({ id: session.id })
				.from(session)
				.all()
				.map(({ id }) => toSessionId(id))
				.sort(),
		withReadyGenerationRead: (sessionIds, operation) =>
			db.transaction((tx) => {
				const maintenance = tx
					.select({
						catalogRevision: sessionProjectionState.catalogRevision,
						generation: sessionProjectionState.generation,
						projectionId: sessionProjectionState.projectionId,
						latestDeletionRevision:
							sessionProjectionState.latestDeletionRevision,
						paginationVersion: sessionProjectionState.paginationVersion,
						status: sessionProjectionState.status,
					})
					.from(sessionProjectionState)
					.where(eq(sessionProjectionState.id, 1))
					.get();
				if (maintenance === undefined) {
					throw new Error("Session projection maintenance state is missing.");
				}
				const staleSessionId = sessionIds.find((sessionId) => {
					const cursor = tx
						.select({ generation: sessionProjectionCursor.generation })
						.from(sessionProjectionCursor)
						.where(eq(sessionProjectionCursor.sessionId, sessionId))
						.get();
					return cursor?.generation !== maintenance.generation;
				});
				const message =
					"Session projection maintenance or replay is incomplete; retry `wincode sessions rebuild` before reading recent Model selections.";
				if (maintenance.status === "rebuilding") {
					const sessionId = sessionIds[0];
					if (sessionId === undefined) {
						throw Object.assign(new Error(message), {
							code: "session_projection_blocked",
						});
					}
					throw new SessionLogError(
						"session_projection_blocked",
						sessionId,
						message
					);
				}
				if (staleSessionId !== undefined) {
					throw new SessionLogError(
						"session_projection_blocked",
						staleSessionId,
						message
					);
				}
				return operation(maintenance);
			}),
		projectEntries: (
			sessionId,
			entries,
			state,
			expectedCursor,
			mode = "append"
		) => {
			const maintenance = db
				.select({ status: sessionProjectionState.status })
				.from(sessionProjectionState)
				.where(eq(sessionProjectionState.id, 1))
				.get();
			if (maintenance === undefined) {
				throw new Error("Session projection maintenance state is missing.");
			}
			assertProjectionMaintenanceMode(maintenance.status, mode);
			const targetWorkspaceId = bindSessionProjectionWorkspace(
				operationalDb,
				sessionId,
				workspaceId,
				mode
			);
			db.transaction((tx) => {
				const currentMaintenance = tx
					.select({
						catalogRevision: sessionProjectionState.catalogRevision,
						generation: sessionProjectionState.generation,
						latestDeletionRevision:
							sessionProjectionState.latestDeletionRevision,
						paginationVersion: sessionProjectionState.paginationVersion,
						status: sessionProjectionState.status,
					})
					.from(sessionProjectionState)
					.where(eq(sessionProjectionState.id, 1))
					.get();
				if (currentMaintenance === undefined) {
					throw new Error("Session projection maintenance state is missing.");
				}
				assertProjectionMaintenanceMode(currentMaintenance.status, mode);
				const currentCursor = tx
					.select({
						generation: sessionProjectionCursor.generation,
						lastHash: sessionProjectionCursor.lastHash,
						logId: sessionProjectionCursor.logId,
						nextByteOffset: sessionProjectionCursor.nextByteOffset,
						nextSequence: sessionProjectionCursor.nextSequence,
					})
					.from(sessionProjectionCursor)
					.where(eq(sessionProjectionCursor.sessionId, sessionId))
					.get();
				if (!sessionProjectionCursorsEqual(currentCursor, expectedCursor)) {
					throw new Error("Session projection cursor changed during replay.");
				}
				if (mode !== "append") {
					tx.delete(sessionCompaction)
						.where(eq(sessionCompaction.sessionId, sessionId))
						.run();
					tx.delete(sessionRecordMessageIdentity)
						.where(eq(sessionRecordMessageIdentity.sessionId, sessionId))
						.run();
					tx.delete(sessionRecord)
						.where(eq(sessionRecord.sessionId, sessionId))
						.run();
					tx.delete(sessionUsageEntry)
						.where(eq(sessionUsageEntry.sessionId, sessionId))
						.run();
					tx.delete(session).where(eq(session.id, sessionId)).run();
					tx.delete(sessionProjectionCursor)
						.where(eq(sessionProjectionCursor.sessionId, sessionId))
						.run();
				}

				const assertSessionBinding = (): void => {
					const currentBinding = operationalDb
						.select({ workspaceId: localSessionBinding.workspaceId })
						.from(localSessionBinding)
						.where(eq(localSessionBinding.sessionId, sessionId))
						.get();
					if (currentBinding?.workspaceId !== targetWorkspaceId) {
						throw new Error("Session projection workspace binding is invalid.");
					}
				};

				let catalogRevision = currentMaintenance.catalogRevision;
				let latestDeletionRevision = currentMaintenance.latestDeletionRevision;
				const pendingJoinedTurnReferences: string[] = [];

				const snapshotSession = (revision: number): void => {
					const row = tx
						.select()
						.from(session)
						.where(eq(session.id, sessionId))
						.get();
					if (row === undefined) {
						throw new Error("Session catalog snapshot row is missing.");
					}
					tx.update(sessionCatalogVersion)
						.set({ validToRevision: revision })
						.where(
							and(
								eq(sessionCatalogVersion.sessionId, sessionId),
								isSqlNull(sessionCatalogVersion.validToRevision)
							)
						)
						.run();
					tx.insert(sessionCatalogVersion)
						.values({
							createdAt: row.createdAt,
							generation: currentMaintenance.generation,
							lastMessageAt: row.lastMessageAt,
							modelJson: row.modelJson,
							pinned: row.pinned,
							sessionId,
							thinkingLevel: row.thinkingLevel,
							title: row.title ?? "Untitled Session",
							updatedAt: row.updatedAt,
							validFromRevision: revision,
							workspaceId: targetWorkspaceId,
						})
						.run();
				};

				const projectRecord = (
					record: SessionRecord,
					timestamp: Date,
					sourceSequence: number,
					sessionModel?: ProviderModelSelection,
					sessionThinkingLevel?: SessionRecord["model"]["thinkingLevel"]
				): void => {
					const validationError = getSessionRecordValidationError(record);
					if (validationError !== null) {
						throw new Error(
							`Invalid committed Session Record: ${validationError}.`
						);
					}
					const existing = tx
						.select()
						.from(sessionRecord)
						.where(eq(sessionRecord.recordId, record.id))
						.get();
					if (existing !== undefined) {
						throw new Error(
							"Session log contains a duplicate retained record identity."
						);
					}
					const latest = tx
						.select({ position: sessionRecord.position })
						.from(sessionRecord)
						.where(eq(sessionRecord.sessionId, sessionId))
						.orderBy(desc(sessionRecord.position))
						.limit(1)
						.get();
					const position = (latest?.position ?? -1) + 1;
					tx.insert(sessionRecord)
						.values({
							agentId: record.agentId,
							createdAt: timestamp,
							messagesJson: serializeJson(record.messages),
							modelJson: serializeJson(record.model),
							outcomeJson: serializeJson(record.outcome),
							position,
							recordId: record.id,
							sessionId,
							sourceSequence,
							turnId: record.turnId,
							version: record.version as SessionRecord["version"],
						})
						.run();
					pendingJoinedTurnReferences.push(
						...projectSessionRecordMessageIdentities(tx, sessionId, record)
					);
					tx.insert(sessionRecordVersion)
						.values({
							messagesJson: serializeJson(record.messages),
							position,
							recordId: record.id,
							sessionId,
							sourceSequence,
							validFromSequence: sourceSequence,
						})
						.run();
					projectRecordToolCalls(tx, sessionId, record, sourceSequence);
					tx.update(session)
						.set({
							lastMessageAt: timestamp,
							updatedAt: timestamp,
							...omitUndefined(
								sessionModel === undefined
									? {}
									: {
											modelJson: sessionModel,
											thinkingLevel: sessionThinkingLevel ?? null,
										}
							),
						})
						.where(eq(session.id, sessionId))
						.run();
				};

				const projectCreation = (entry: SessionLogEntry): void => {
					const payload = entry.envelope.payload;
					const createdAt = new Date(String(payload.createdAt));
					const model =
						payload.model === undefined
							? undefined
							: providerModelSelectionSchema.parse(payload.model);
					const thinkingLevel =
						payload.thinkingLevel === undefined
							? undefined
							: thinkingLevelSchema.parse(payload.thinkingLevel);
					const existingSession = tx
						.select({ id: session.id })
						.from(session)
						.where(eq(session.id, sessionId))
						.get();
					const values = {
						createdAt,
						editMode: payload.editMode as EditMode,
						id: sessionId,
						lastMessageAt:
							payload.lastMessageAt === null
								? null
								: new Date(String(payload.lastMessageAt)),
						modelJson: model,
						pinned: payload.pinned as boolean,
						thinkingLevel,
						title: payload.title as string,
						updatedAt: createdAt,
					};
					if (existingSession === undefined) {
						tx.insert(session).values(values).run();
					} else {
						tx.update(session)
							.set({
								editMode: values.editMode,
								lastMessageAt: values.lastMessageAt,
								modelJson: values.modelJson,
								pinned: values.pinned,
								thinkingLevel: values.thinkingLevel,
								title: values.title,
								updatedAt: values.updatedAt,
							})
							.where(eq(session.id, sessionId))
							.run();
					}
					const record = asRecord(entry);
					if (record !== undefined) {
						projectRecord(
							record,
							createdAt,
							entry.envelope.sequence,
							model,
							thinkingLevel
						);
					}
				};

				const projectRecordEntry = (
					entry: SessionLogEntry,
					timestamp: Date
				): void => {
					assertSessionBinding();
					const record = asRecord(entry);
					if (record === undefined) {
						throw new Error("Committed Session Record is missing.");
					}
					const payload = entry.envelope.payload;
					projectRecord(
						record,
						timestamp,
						entry.envelope.sequence,
						payload.sessionModel as ProviderModelSelection | undefined,
						payload.sessionThinkingLevel as
							| SessionRecord["model"]["thinkingLevel"]
							| undefined
					);
				};

				const projectMetadataUpdate = (
					entry: SessionLogEntry,
					timestamp: Date
				): void => {
					assertSessionBinding();
					const payload = entry.envelope.payload;
					tx.update(session)
						.set({
							updatedAt: timestamp,
							...omitUndefined({
								title: payload.title as string | undefined,
								pinned: payload.pinned as boolean | undefined,
								editMode: payload.editMode as EditMode | undefined,
								modelJson: payload.model as ProviderModelSelection | undefined,
								thinkingLevel: payload.thinkingLevel as
									| SessionRecord["model"]["thinkingLevel"]
									| undefined,
							}),
						})
						.where(eq(session.id, sessionId))
						.run();
				};

				const projectSubmissionStatus = (
					entry: SessionLogEntry,
					sequence: number
				): void => {
					assertSessionBinding();
					const payload = entry.envelope.payload;
					const row = tx
						.select()
						.from(sessionRecord)
						.where(eq(sessionRecord.recordId, String(payload.recordId)))
						.get();
					if (row === undefined || row.sessionId !== sessionId) {
						throw new Error("Submission status refers to a missing record.");
					}
					const record: SessionRecord = {
						agentId: agentIdSchema.parse(row.agentId),
						id: toSessionRecordId(row.recordId),
						messages: row.messagesJson,
						model: row.modelJson,
						outcome: row.outcomeJson,
						turnId: toAgentTurnId(row.turnId),
						version: row.version as SessionRecord["version"],
					};
					const messageIndex = record.messages.findIndex(
						(message) =>
							message.role === "user" && message.id === payload.messageId
					);
					const message = record.messages[messageIndex];
					if (
						message === undefined ||
						message.metadata?.submissionId !== payload.submissionId
					) {
						throw new Error("Submission status identity does not match.");
					}
					const updatedMessage = withSubmissionStatus(message, {
						failure: payload.failure as string | undefined,
						status: payload.status as
							| "failed"
							| "pending"
							| "processed"
							| "processing",
						submissionId: toSubmissionId(String(payload.submissionId)),
					});
					const messages = [...record.messages];
					messages[messageIndex] = updatedMessage;
					const validationError = getSessionRecordValidationError({
						...record,
						messages,
					});
					if (!isNull(validationError)) {
						throw new Error(`Invalid Submission update: ${validationError}.`);
					}
					const activeVersion = tx
						.select({
							position: sessionRecordVersion.position,
							sourceSequence: sessionRecordVersion.sourceSequence,
						})
						.from(sessionRecordVersion)
						.where(
							and(
								eq(sessionRecordVersion.sessionId, sessionId),
								eq(sessionRecordVersion.recordId, record.id),
								isSqlNull(sessionRecordVersion.validToSequence)
							)
						)
						.get();
					if (activeVersion === undefined) {
						throw new Error("Session Record version is missing.");
					}
					tx.update(sessionRecordVersion)
						.set({ validToSequence: sequence })
						.where(
							and(
								eq(sessionRecordVersion.sessionId, sessionId),
								eq(sessionRecordVersion.recordId, record.id),
								isSqlNull(sessionRecordVersion.validToSequence)
							)
						)
						.run();
					tx.insert(sessionRecordVersion)
						.values({
							messagesJson: serializeJson(messages),
							position: activeVersion.position,
							recordId: record.id,
							sessionId,
							sourceSequence: activeVersion.sourceSequence,
							validFromSequence: sequence,
						})
						.run();
					tx.update(sessionRecord)
						.set({ messagesJson: serializeJson(messages) })
						.where(eq(sessionRecord.recordId, record.id))
						.run();
				};

				const projectDeletion = (): void => {
					assertSessionBinding();
					tx.delete(sessionCompaction)
						.where(eq(sessionCompaction.sessionId, sessionId))
						.run();
					tx.delete(sessionRecordMessageIdentity)
						.where(eq(sessionRecordMessageIdentity.sessionId, sessionId))
						.run();
					tx.delete(sessionRecord)
						.where(eq(sessionRecord.sessionId, sessionId))
						.run();
					tx.delete(sessionUsageEntry)
						.where(eq(sessionUsageEntry.sessionId, sessionId))
						.run();
					tx.delete(session).where(eq(session.id, sessionId)).run();
				};

				const projectContextEdit = (entry: SessionLogEntry): void => {
					assertSessionBinding();
					const edit = sessionContextEditSchema.parse(entry.envelope.payload);
					tx.insert(sessionContextEdit)
						.values({
							operationId: edit.operationId,
							replacementText: edit.replacement?.text ?? null,
							sequence: entry.envelope.sequence,
							sessionId,
							targetId: edit.targetId,
						})
						.run();
				};

				const projectCompaction = (entry: SessionLogEntry): void => {
					assertSessionBinding();
					const payload = parseSessionCompactionPayload(entry.envelope.payload);
					const summarizationModel = providerModelSelectionSchema.parse(
						payload.summarizationModel
					);
					const summarizationUsage =
						payload.summarizationUsage === null
							? null
							: modelUsageSchema.parse(payload.summarizationUsage);
					const id = toCompactionId(payload.id);
					const firstKeptUiMessageId = toSessionMessageId(
						payload.firstKeptUiMessageId
					);
					const throughMessageUiId = toSessionMessageId(
						payload.throughMessageUiId
					);
					const {
						overflowSourceTurnId: rawOverflowSourceTurnId,
						...summaryPayload
					} = payload.summary;
					const summary: SessionCompaction["summary"] = {
						...summaryPayload,
						...omitUndefined({
							overflowSourceTurnId:
								rawOverflowSourceTurnId === undefined
									? undefined
									: toAgentTurnId(rawOverflowSourceTurnId),
						}),
						coveredMessageIds:
							summaryPayload.coveredMessageIds.map(toSessionMessageId),
					};
					assertProjectedCompactionChain(tx, sessionId, payload);
					const availableMessageIds = projectedCompactionMessageIds(
						tx,
						sessionId,
						[
							firstKeptUiMessageId,
							throughMessageUiId,
							...summary.coveredMessageIds,
						]
					);
					assertCompactionMessageReferences(
						{ firstKeptUiMessageId, id, summary, throughMessageUiId },
						availableMessageIds
					);
					const row = {
						completedAt: new Date(String(payload.completedAt)),
						createdAt: new Date(String(payload.createdAt)),
						estimatedTokensAfter: Number(payload.estimatedTokensAfter),
						firstKeptAssistantPartIndex:
							(payload.firstKeptAssistantPartIndex as number | null) ?? null,
						firstKeptUiMessageId,
						focus: (payload.focus as string | null) ?? null,
						id,
						priorCompactionId:
							payload.priorCompactionId === null
								? null
								: toCompactionId(String(payload.priorCompactionId)),
						sequence: Number(payload.sequence),
						sessionId,
						sourceSequence: entry.envelope.sequence,
						summarizationModelJson: serializeJson(summarizationModel),
						summarizationThinkingLevel:
							payload.summarizationThinkingLevel === null
								? null
								: thinkingLevelSchema.parse(payload.summarizationThinkingLevel),
						summarizationUsageJson: serializeJson(
							summarizationUsage as
								| SessionCompaction["summarizationUsage"]
								| null
						),
						summaryJson: serializeJson(summary),
						throughMessageUiId,
						tokensBefore: Number(payload.tokensBefore),
						trigger: payload.trigger as SessionCompaction["trigger"],
					};
					tx.insert(sessionCompaction).values(row).run();
				};

				const projectUsage = (entry: SessionLogEntry): void => {
					assertSessionBinding();
					const payload = entry.envelope.payload;
					const model = providerModelSelectionSchema.parse(payload.model);
					const usage = modelUsageSchema.parse(payload.usage);
					const id = toSessionUsageEntryId(String(payload.id));
					if (
						tx
							.select({ id: sessionUsageEntry.id })
							.from(sessionUsageEntry)
							.where(eq(sessionUsageEntry.id, id))
							.get() !== undefined
					) {
						throw new Error(
							"Session log contains a duplicate Usage Entry identity."
						);
					}
					tx.insert(sessionUsageEntry)
						.values({
							compactionId:
								payload.compactionId === null ||
								payload.compactionId === undefined
									? null
									: String(payload.compactionId),
							costUsd:
								payload.costUsd === null || payload.costUsd === undefined
									? null
									: Number(payload.costUsd),
							createdAt: new Date(String(payload.createdAt)),
							id,
							kind: payload.kind as "cache-warm" | "compaction-summary",
							sourceSequence: entry.envelope.sequence,
							modelJson: serializeJson(model),
							sessionId,
							usageJson: serializeJson(usage),
						})
						.run();
				};

				const projectForkProvenance = (entry: SessionLogEntry): void => {
					assertSessionBinding();
					const provenance = parseSessionForkedPayload(entry.envelope.payload);
					if (
						tx
							.select({ sessionId: sessionForkProvenance.sessionId })
							.from(sessionForkProvenance)
							.where(eq(sessionForkProvenance.sessionId, sessionId))
							.get() !== undefined
					) {
						throw new Error(
							"Session log contains multiple fork provenance checkpoints."
						);
					}
					tx.insert(sessionForkProvenance)
						.values({
							provenanceJson: serializeJson(provenance),
							sessionId,
							sourceSequence: entry.envelope.sequence,
						})
						.run();
				};

				const dispatchProjectionEntry = (
					entry: SessionLogEntry,
					timestamp: Date
				): void => {
					const envelope = entry.envelope;
					switch (envelope.type) {
						case "session.header":
						case "session.activation-confirmed":
							break;
						case "context.edited":
							projectContextEdit(entry);
							break;
						case "session.forked":
							projectForkProvenance(entry);
							break;
						case "session.created":
							projectCreation(entry);
							break;
						case "record.committed":
							projectRecordEntry(entry, timestamp);
							break;
						case "session.metadata-updated":
							projectMetadataUpdate(entry, timestamp);
							break;
						case "submission.status-updated":
							projectSubmissionStatus(entry, envelope.sequence);
							break;
						case "usage.committed":
							projectUsage(entry);
							break;
						case "session.deleted":
							projectDeletion();
							break;
						case "compaction.committed":
							projectCompaction(entry);
							break;
						default:
							throw new Error(
								`Unsupported Session log event ${String(envelope.type)}.`
							);
					}
				};

				const projectEntry = (
					entry: SessionLogEntry,
					revision: number
				): void => {
					const envelope = entry.envelope;
					assertProjectionEntryIsSafe(tx, sessionId, envelope);
					const timestamp = new Date(envelope.timestamp);
					dispatchProjectionEntry(entry, timestamp);
					if (
						envelope.type === "session.created" ||
						envelope.type === "record.committed" ||
						envelope.type === "session.metadata-updated"
					) {
						snapshotSession(revision);
					} else if (envelope.type === "session.deleted") {
						latestDeletionRevision = revision;
						tx.insert(sessionCatalogDeletionState)
							.values({
								latestDeletionRevision: revision,
								workspaceId: targetWorkspaceId,
							})
							.onConflictDoUpdate({
								set: { latestDeletionRevision: revision },
								target: sessionCatalogDeletionState.workspaceId,
							})
							.run();
					}
					if (
						envelope.type !== "session.header" &&
						envelope.type !== "session.deleted"
					) {
						tx.insert(sessionOperationLookup)
							.values({
								entryHash: envelope.entryHash,
								operationDigest: sessionLogOperationDigest(
									envelope.type,
									envelope.payload
								),
								operationId: envelope.operationId,
								sequence: envelope.sequence,
								sessionId,
								type: envelope.type,
							})
							.run();
					}
				};
				for (const entry of entries) {
					if (!Number.isSafeInteger(catalogRevision + 1)) {
						throw new Error("Session catalog revision is unavailable.");
					}
					catalogRevision += 1;
					projectEntry(entry, catalogRevision);
				}
				assertJoinedTurnReferencesExist(
					tx,
					sessionId,
					pendingJoinedTurnReferences
				);

				tx.update(sessionProjectionState)
					.set({ catalogRevision, latestDeletionRevision })
					.where(eq(sessionProjectionState.id, 1))
					.run();

				tx.insert(sessionProjectionCursor)
					.values({
						generation: currentMaintenance.generation,
						lastHash: state.lastHash,
						logId: state.logId,
						nextByteOffset: state.nextOffset,
						nextSequence: state.nextSequence,
						sessionId,
					})
					.onConflictDoUpdate({
						set: {
							generation: currentMaintenance.generation,
							lastHash: state.lastHash,
							logId: state.logId,
							nextByteOffset: state.nextOffset,
							nextSequence: state.nextSequence,
						},
						target: sessionProjectionCursor.sessionId,
					})
					.run();
			});
		},
	};
};
