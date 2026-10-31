import {
	agentIdSchema,
	type SessionRecord,
	toAgentTurnId,
	toSessionMessageId,
	toSessionRecordId,
	toSubmissionId,
} from "@wincode/agent-core";
import { modelUsageSchema, thinkingLevelSchema } from "@wincode/ai";
import { isNull, omitUndefined } from "@wincode/utils";
import { desc, eq } from "drizzle-orm";
import {
	type ProviderModelSelection,
	providerModelSelectionSchema,
} from "@/modules/providers/provider-model-selection";
import type { EditMode } from "@/modules/tools";
import {
	toCompactionId,
	toSessionUsageEntryId,
	type WorkspaceId,
} from "@/shared/identifiers";
import type { SessionCompaction } from "../compaction/types";
import { withSubmissionStatus } from "../message";
import type { SessionDatabase } from "./client";
import type { SerializedJson } from "./schema";
import {
	localSessionBinding,
	session,
	sessionCompaction,
	sessionProjectionCursor,
	sessionRecord,
	sessionUsageEntry,
} from "./schema";
import {
	type SessionJsonlProjection,
	type SessionLogEntry,
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

export const createSessionJsonlProjection = (
	db: SessionDatabase,
	operationalDb: SessionDatabase,
	workspaceId: WorkspaceId
): SessionJsonlProjection => ({
	getCursor: (sessionId) => {
		const row = db
			.select({
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
	isBoundToAnotherWorkspace: (sessionId) => {
		const binding = operationalDb
			.select({ workspaceId: localSessionBinding.workspaceId })
			.from(localSessionBinding)
			.where(eq(localSessionBinding.sessionId, sessionId))
			.get();
		return binding !== undefined && binding.workspaceId !== workspaceId;
	},
	projectEntries: (sessionId, entries, state, expectedCursor) => {
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
		db.transaction((tx) => {
			const currentCursor = tx
				.select({
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

			const assertSessionBinding = (): void => {
				const currentBinding = operationalDb
					.select({ workspaceId: localSessionBinding.workspaceId })
					.from(localSessionBinding)
					.where(eq(localSessionBinding.sessionId, sessionId))
					.get();
				if (currentBinding?.workspaceId !== workspaceId) {
					throw new Error("Session projection workspace binding is invalid.");
				}
			};

			const projectRecord = (
				record: SessionRecord,
				timestamp: Date,
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
					const matches =
						existing.sessionId === sessionId &&
						existing.turnId === record.turnId &&
						existing.agentId === record.agentId &&
						existing.version === record.version &&
						Bun.deepEquals(existing.modelJson, record.model, true) &&
						Bun.deepEquals(existing.outcomeJson, record.outcome, true) &&
						Bun.deepEquals(existing.messagesJson, record.messages, true);
					if (!matches) {
						throw new Error(
							"Session Record identity was reused with new data."
						);
					}
					return;
				}
				const latest = tx
					.select({ position: sessionRecord.position })
					.from(sessionRecord)
					.where(eq(sessionRecord.sessionId, sessionId))
					.orderBy(desc(sessionRecord.position))
					.limit(1)
					.get();
				tx.insert(sessionRecord)
					.values({
						agentId: record.agentId,
						createdAt: timestamp,
						messagesJson: serializeJson(record.messages),
						modelJson: serializeJson(record.model),
						outcomeJson: serializeJson(record.outcome),
						position: (latest?.position ?? -1) + 1,
						recordId: record.id,
						sessionId,
						turnId: record.turnId,
						version: record.version as SessionRecord["version"],
					})
					.run();
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
					projectRecord(record, createdAt, model, thinkingLevel);
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

			const projectSubmissionStatus = (entry: SessionLogEntry): void => {
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
				tx.delete(sessionRecord)
					.where(eq(sessionRecord.sessionId, sessionId))
					.run();
				tx.delete(sessionUsageEntry)
					.where(eq(sessionUsageEntry.sessionId, sessionId))
					.run();
				tx.delete(session).where(eq(session.id, sessionId)).run();
			};

			const projectCompaction = (entry: SessionLogEntry): void => {
				assertSessionBinding();
				const payload = entry.envelope.payload;
				const summarizationModel = providerModelSelectionSchema.parse(
					payload.summarizationModel
				);
				const summarizationUsage =
					payload.summarizationUsage === null
						? null
						: modelUsageSchema.parse(payload.summarizationUsage);
				const row = {
					completedAt: new Date(String(payload.completedAt)),
					createdAt: new Date(String(payload.createdAt)),
					estimatedTokensAfter: Number(payload.estimatedTokensAfter),
					firstKeptAssistantPartIndex:
						(payload.firstKeptAssistantPartIndex as number | null) ?? null,
					firstKeptUiMessageId: toSessionMessageId(
						String(payload.firstKeptUiMessageId)
					),
					focus: (payload.focus as string | null) ?? null,
					id: toCompactionId(String(payload.id)),
					priorCompactionId:
						payload.priorCompactionId === null
							? null
							: toCompactionId(String(payload.priorCompactionId)),
					sequence: Number(payload.sequence),
					sessionId,
					summarizationModelJson: serializeJson(summarizationModel),
					summarizationThinkingLevel:
						payload.summarizationThinkingLevel === null
							? null
							: thinkingLevelSchema.parse(payload.summarizationThinkingLevel),
					summarizationUsageJson: serializeJson(
						summarizationUsage as SessionCompaction["summarizationUsage"] | null
					),
					summaryJson: serializeJson(
						payload.summary as SessionCompaction["summary"]
					),
					throughMessageUiId: toSessionMessageId(
						String(payload.throughMessageUiId)
					),
					tokensBefore: Number(payload.tokensBefore),
					trigger: payload.trigger as SessionCompaction["trigger"],
				};
				tx.insert(sessionCompaction).values(row).onConflictDoNothing().run();
			};

			const projectUsage = (entry: SessionLogEntry): void => {
				assertSessionBinding();
				const payload = entry.envelope.payload;
				const model = providerModelSelectionSchema.parse(payload.model);
				const usage = modelUsageSchema.parse(payload.usage);
				tx.insert(sessionUsageEntry)
					.values({
						createdAt: new Date(String(payload.createdAt)),
						id: toSessionUsageEntryId(String(payload.id)),
						kind: payload.kind as "cache-warm" | "compaction-summary",
						modelJson: serializeJson(model),
						sessionId,
						usageJson: serializeJson(usage),
					})
					.onConflictDoNothing()
					.run();
			};

			const projectEntry = (entry: SessionLogEntry): void => {
				const envelope = entry.envelope;
				if (envelope.sessionId !== sessionId) {
					throw new Error("Session log projection contains a foreign entry.");
				}
				const timestamp = new Date(envelope.timestamp);
				switch (envelope.type) {
					case "session.header":
					case "session.activation-confirmed":
						return;
					case "session.created":
						projectCreation(entry);
						return;
					case "record.committed":
						projectRecordEntry(entry, timestamp);
						return;
					case "session.metadata-updated":
						projectMetadataUpdate(entry, timestamp);
						return;
					case "submission.status-updated":
						projectSubmissionStatus(entry);
						return;
					case "usage.committed":
						projectUsage(entry);
						return;
					case "session.deleted":
						projectDeletion();
						return;
					case "compaction.committed":
						projectCompaction(entry);
						return;
					default:
						throw new Error(
							`Unsupported Session log event ${String(envelope.type)}.`
						);
				}
			};
			for (const entry of entries) {
				projectEntry(entry);
			}

			tx.insert(sessionProjectionCursor)
				.values({
					lastHash: state.lastHash,
					logId: state.logId,
					nextByteOffset: state.nextOffset,
					nextSequence: state.nextSequence,
					sessionId,
				})
				.onConflictDoUpdate({
					set: {
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
});
