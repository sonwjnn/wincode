import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createOperationalFailure,
	isSessionAttachmentReferencePart,
	SESSION_RECORD_VERSION,
	type SessionRecord,
	type SessionToolCallPart,
	toSubmissionId,
} from "@wincode/agent-core";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceToFilePart } from "@/modules/sessions/attachment-reference";
import { createSessionUserMessage } from "@/modules/sessions/message";
import { isValidSessionLogIdentifier } from "@/modules/sessions/session-log-identifiers";
import {
	createMemoryAttachmentMetadataRepository,
	createSessionAttachmentStore,
} from "@/modules/sessions/storage/attachment-store";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "@/modules/sessions/storage/path";
import {
	createSessionLogEvent,
	decodeSessionLog,
	encodeSessionLogLine,
	isSessionRecord,
	SessionLogError,
} from "@/modules/sessions/storage/session-jsonl-codec";
import type { SessionLogFileIo } from "@/modules/sessions/storage/session-jsonl-store";
import { createSessionJsonlStore } from "@/modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type {
	SessionForkCheckpoint,
	SessionForkResult,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import { acquireSessionWriterLock } from "@/modules/sessions/storage/session-writer-lock";
import { aggregateSessionStatisticsUsage } from "@/modules/sessions/usage/session-statistics";
import type { FileVersion } from "@/modules/tools/versioned/model";
import type { SessionId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	compactionId,
	modelStepId,
	providerModelSelectionFixture,
	sessionMessageId,
	sessionRecordId,
	toolCallId,
} from "../support/identifiers";

const temporaryRoot = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-session-fork-")
);
const workspace = path.join(temporaryRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

afterAll(async () => {
	await fs.rm(temporaryRoot, { force: true, recursive: true });
});

const createPersistence = (
	name: string,
	fileIo: SessionLogFileIo = {}
): {
	close: () => void;
	createStore: (fileIo?: SessionLogFileIo) => SessionStore;
	logRoot: string;
	store: SessionStore;
} => {
	const databasePath = path.join(temporaryRoot, `${name}.sqlite`);
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const projectionStore = createDrizzleSessionStore(projection.db, {
		attachmentRoot: path.join(temporaryRoot, "attachments"),
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const createStore = (storeFileIo: SessionLogFileIo = fileIo): SessionStore =>
		createSessionJsonlStore(projectionStore, logRoot, storeFileIo);
	return {
		close: () => {
			operational.sqlite.close();
			projection.sqlite.close();
		},
		createStore,
		logRoot,
		store: createStore(),
	};
};

const invokeFork = (
	store: SessionStore,
	sourceSessionId: SessionId,
	checkpoint: SessionForkCheckpoint,
	operationId: string
): Promise<SessionForkResult> =>
	store.forkSession(sourceSessionId, checkpoint, operationId);

const completedToolRecord = ({
	batchCallIds,
	callId,
	id,
	messageId,
	sourceUserMessageId,
	turnId,
}: {
	batchCallIds: readonly string[];
	callId: string;
	id: string;
	messageId: string;
	sourceUserMessageId: SessionRecord["messages"][number]["id"];
	turnId: SessionRecord["turnId"];
}): SessionRecord => ({
	agentId: agentId("build"),
	id: sessionRecordId(id),
	messages: [
		{
			id: sessionMessageId(messageId),
			metadata: { sourceUserMessageId },
			parts: [
				{
					input: { path: "README.md" },
					outcome: { kind: "success", output: { unchanged: true } },
					sequence: 5,
					toolBatch: {
						id: modelStepId("fork-tool-batch-step"),
						toolCallIds: batchCallIds.map((value) => toolCallId(value)),
					},
					toolCallId: toolCallId(callId),
					toolName: "read",
					type: "tool-call",
				},
			],
			role: "assistant",
		},
	],
	model: DEFAULT_PROVIDER_MODEL_SELECTION,
	outcome: { kind: "tool" },
	turnId,
	version: SESSION_RECORD_VERSION,
});

test("UI fork retries reuse a durable ID, then allow a later fork of the same cut", async () => {
	const persistence = createPersistence("fork-action-id");
	const sourceTurnId = agentTurnId("fork-action-id-turn");
	try {
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("Fork action identity source."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("fork-action-id-checkpoint"),
			messages: [
				{
					id: sessionMessageId("fork-action-id-message"),
					parts: [{ text: "The source turn completed.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminalRecord,
			sessionId: created.id,
		});
		const checkpoint = { recordId: terminalRecord.id };
		const firstActionId =
			await persistence.store.getOrCreateSessionForkActionId(
				created.id,
				checkpoint
			);
		const restartedStore = persistence.createStore();
		const retryActionId = await restartedStore.getOrCreateSessionForkActionId(
			created.id,
			checkpoint
		);
		expect(retryActionId).toBe(firstActionId);
		expect(isValidSessionLogIdentifier(firstActionId)).toBe(true);

		const firstFork = await invokeFork(
			persistence.store,
			created.id,
			checkpoint,
			firstActionId
		);
		const retriedFork = await invokeFork(
			restartedStore,
			created.id,
			checkpoint,
			retryActionId
		);
		expect(firstFork.created).toBe(true);
		expect(retriedFork.created).toBe(false);
		expect(retriedFork.id).toBe(firstFork.id);

		await restartedStore.completeSessionForkAction(
			created.id,
			checkpoint,
			firstActionId
		);
		const laterActionId =
			await persistence.store.getOrCreateSessionForkActionId(
				created.id,
				checkpoint
			);
		expect(laterActionId).not.toBe(firstActionId);
		expect(
			await restartedStore.getOrCreateSessionForkActionId(
				created.id,
				checkpoint
			)
		).toBe(laterActionId);
		const laterFork = await invokeFork(
			persistence.store,
			created.id,
			checkpoint,
			laterActionId
		);
		expect(laterFork.created).toBe(true);
		expect(laterFork.id).not.toBe(firstFork.id);
	} finally {
		persistence.close();
	}
});

test("forked attachment references remain live after source deletion and attachment collection", async () => {
	const databasePath = path.join(temporaryRoot, "attachment-fork.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const attachmentStore = createSessionAttachmentStore({
		lifecycleRoot: logRoot,
		repository: createMemoryAttachmentMetadataRepository(),
		root: path.join(temporaryRoot, "attachment-fork-blobs"),
	});
	const projectionStore = createDrizzleSessionStore(projection.db, {
		attachmentRoot: path.join(temporaryRoot, "attachment-fork-blobs"),
		attachmentStore,
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot);
	const imageBytes = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
	]);
	const attachmentLease = await attachmentStore.ingest({
		bytes: imageBytes,
		filename: "fork-image.png",
		mediaType: "image/png",
	});
	const reference = attachmentLease.reference;
	await attachmentLease.release();
	try {
		const created = await store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage(
				"Keep this image available in the fork.",
				undefined,
				[],
				[attachmentReferenceToFilePart(reference)]
			),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("fork-attachment-turn"),
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("fork-attachment-terminal-record"),
			messages: [
				{
					id: sessionMessageId("fork-attachment-terminal-message"),
					parts: [{ text: "The image context is retained.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: agentTurnId("fork-attachment-turn"),
			version: SESSION_RECORD_VERSION,
		};
		await store.commitSessionRecord({
			record: terminalRecord,
			sessionId: created.id,
		});
		const forked = await invokeFork(
			store,
			created.id,
			{ recordId: terminalRecord.id },
			"fork-attachment-lifetime"
		);
		const sourceDeletion = await store.deleteSession(created.id);
		expect(sourceDeletion).toMatchObject({ kind: "committed" });

		await attachmentStore.collect({ liveAttachmentIds: [], safetyWindowMs: 0 });
		const resolved = await attachmentStore.resolve(reference);
		if (resolved.availability !== "available") {
			throw new Error(
				"The fork attachment was not retained after source deletion."
			);
		}
		const forkRecords = await store.listSessionRecords(forked.id);
		const persistedAttachmentIds = forkRecords
			.flatMap((record) => record.messages)
			.flatMap((message) => message.parts)
			.flatMap((part) =>
				isSessionAttachmentReferencePart(part) ? [part.attachmentId] : []
			);

		expect(persistedAttachmentIds).toContain(reference.attachmentId);
		expect(resolved.bytes).toEqual(imageBytes);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("a refused multi-message record leaves no fork checkpoint target", async () => {
	const persistence = createPersistence("multi-message-cut");
	try {
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("Keep this source Session intact."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("multi-message-cut-turn"),
		});
		const sourceRecords = await persistence.store.listSessionRecords(
			created.id
		);
		const sourceRecord = sourceRecords[0];
		const sourceMessage = sourceRecord?.messages[0];
		if (sourceRecord === undefined || sourceMessage === undefined) {
			throw new Error("Source Session has no accepted user record.");
		}
		const multiMessageRecord: SessionRecord = {
			...sourceRecord,
			id: sessionRecordId("multi-message-cut-record"),
			messages: [
				sourceMessage,
				{
					...sourceMessage,
					id: sessionMessageId("multi-message-cut-second-message"),
					parts: [
						{ text: "This second message cannot be omitted.", type: "text" },
					],
				},
			],
		};
		const sourceLogPath = path.join(
			persistence.logRoot,
			created.id,
			"session.jsonl"
		);
		const sourceLogBytes = await Bun.file(sourceLogPath).bytes();

		const invalidRecordWrite = await persistence.store.commitSessionRecord({
			record: multiMessageRecord,
			sessionId: created.id,
		});
		expect(invalidRecordWrite).toMatchObject({
			kind: "not-committed",
			error: {
				code: "session_log_corrupt",
				message:
					"Invalid committed Session Record: record must contain one durable message.",
			},
		});
		await expect(
			invokeFork(
				persistence.store,
				created.id,
				{ recordId: multiMessageRecord.id },
				"multi-message-cut-refusal"
			)
		).rejects.toMatchObject({
			code: "session_checkpoint_invalid",
			message: "Checkpoint Record was not found in the source Session.",
		});

		expect(
			(await persistence.store.listSessions()).map(({ id }) => id)
		).toEqual([created.id]);
		expect(await persistence.store.listSessionRecords(created.id)).toEqual(
			sourceRecords
		);
		expect([...(await Bun.file(sourceLogPath).bytes())]).toEqual([
			...sourceLogBytes,
		]);
	} finally {
		persistence.close();
	}
});

test("fork storage accepts an accepted user boundary and rejects interrupted Agent Turn outcomes", async () => {
	const persistence = createPersistence("invalid-cut");
	try {
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("This is not a fork checkpoint."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("invalid-cut-user-turn"),
		});
		const initialRecord = (
			await persistence.store.listSessionRecords(created.id)
		)[0];
		if (initialRecord === undefined) {
			throw new Error(
				"Session creation did not persist its initial user record."
			);
		}
		const userFork = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: initialRecord.id },
			"accepted-user-checkpoint"
		);
		expect(userFork.created).toBe(true);
		expect(
			await persistence.store.listSessionRecords(userFork.id)
		).toHaveLength(1);

		const interruptedRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("invalid-cut-interrupted-record"),
			messages: [
				{
					id: sessionMessageId("invalid-cut-interrupted-message"),
					parts: [{ text: "This Agent Turn did not complete.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: {
					failure: createOperationalFailure({
						code: "interrupted",
						retry: "never",
						source: "runtime",
					}),
					finishedAt: 1_800_000_000_000,
					kind: "interrupted",
					reason: "user",
				},
			},
			turnId: agentTurnId("invalid-cut-user-turn"),
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: interruptedRecord,
			sessionId: created.id,
		});
		await expect(
			invokeFork(
				persistence.store,
				created.id,
				{ recordId: interruptedRecord.id },
				"invalid-interrupted-checkpoint"
			)
		).rejects.toMatchObject({ code: "session_checkpoint_invalid" });
		expect(await persistence.store.listSessions()).toHaveLength(2);
	} finally {
		persistence.close();
	}
});

test("rewinding from an accepted pending user keeps source JSONL and workspace bytes unchanged", async () => {
	const persistence = createPersistence("rewind-user-preservation");
	const workspacePath = path.join(workspace, "rewind-user-preservation.txt");
	const workspaceBytes = new TextEncoder().encode(
		"workspace bytes stay unchanged\n"
	);
	await Bun.write(workspacePath, workspaceBytes);
	const submissionId = toSubmissionId("rewind-source-pending-submission");
	try {
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage(
				"Keep this accepted input as context only.",
				{ submissionId, submissionStatus: "pending" },
				[],
				[],
				sessionMessageId("rewind-source-pending-message")
			),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("rewind-source-pending-turn"),
		});
		const sourceRecords = await persistence.store.listSessionRecords(
			created.id
		);
		const sourceLogPath = path.join(
			persistence.logRoot,
			created.id,
			"session.jsonl"
		);
		const sourceLogBytes = await Bun.file(sourceLogPath).bytes();
		const checkpoint = sourceRecords[0];
		if (checkpoint === undefined) {
			throw new Error("Source Session has no accepted user record.");
		}

		const forked = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: checkpoint.id },
			"rewind-user-source-preservation"
		);
		const inheritedRecord = (
			await persistence.store.listSessionRecords(forked.id)
		)[0];
		const inheritedMessage = inheritedRecord?.messages[0];

		expect(inheritedMessage?.metadata?.submissionStatus).toBe("processed");
		expect(inheritedMessage?.metadata?.submissionId).not.toBe(submissionId);
		expect(
			(await persistence.store.getSessionForkProvenance(forked.id))
				?.inheritedSubmissions
		).toMatchObject([{ sourceSubmissionId: submissionId, status: "pending" }]);
		expect(await persistence.store.listSessionRecords(created.id)).toEqual(
			sourceRecords
		);
		expect([...(await Bun.file(sourceLogPath).bytes())]).toEqual([
			...sourceLogBytes,
		]);
		expect([...(await Bun.file(workspacePath).bytes())]).toEqual([
			...workspaceBytes,
		]);
	} finally {
		persistence.close();
	}
});

test("fork refuses a Tool Call cut inside an incomplete parallel batch before publishing", async () => {
	const persistence = createPersistence("incomplete-tool-batch-cut");
	try {
		const sourceTurnId = agentTurnId("incomplete-tool-batch-turn");
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("Inspect these files safely."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const sourceUser = (
			await persistence.store.listSessionRecords(created.id)
		)[0];
		const sourceMessageId = sourceUser?.messages[0]?.id;
		if (sourceMessageId === undefined) {
			throw new Error("Source Session has no accepted user message.");
		}
		const firstResult = completedToolRecord({
			batchCallIds: ["fork-parallel-first-call", "fork-parallel-second-call"],
			callId: "fork-parallel-first-call",
			id: "fork-parallel-first-result",
			messageId: "fork-parallel-first-message",
			sourceUserMessageId: sourceMessageId,
			turnId: sourceTurnId,
		});
		const secondResult = completedToolRecord({
			batchCallIds: ["fork-parallel-first-call", "fork-parallel-second-call"],
			callId: "fork-parallel-second-call",
			id: "fork-parallel-second-result",
			messageId: "fork-parallel-second-message",
			sourceUserMessageId: sourceMessageId,
			turnId: sourceTurnId,
		});
		await persistence.store.commitSessionRecord({
			record: firstResult,
			sessionId: created.id,
		});
		const sourceLogPath = path.join(
			persistence.logRoot,
			created.id,
			"session.jsonl"
		);
		const incompleteSourceBytes = await Bun.file(sourceLogPath).bytes();
		const operationId = "incomplete-tool-batch-retry";
		await expect(
			invokeFork(
				persistence.store,
				created.id,
				{ recordId: firstResult.id },
				operationId
			)
		).rejects.toMatchObject({
			code: "session_checkpoint_invalid",
			message: "Parallel Tool Call batch is incomplete at this checkpoint.",
		});
		expect(await persistence.store.listSessions()).toHaveLength(1);
		expect([...(await Bun.file(sourceLogPath).bytes())]).toEqual([
			...incompleteSourceBytes,
		]);

		await persistence.store.commitSessionRecord({
			record: secondResult,
			sessionId: created.id,
		});
		const forked = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: secondResult.id },
			operationId
		);
		expect(forked.created).toBe(true);
		const forkedRecords = await persistence.store.listSessionRecords(forked.id);
		expect(forkedRecords).toHaveLength(3);
		const forkedToolParts = forkedRecords.flatMap((record) =>
			record.messages.flatMap((message) =>
				message.parts.filter(
					(part): part is SessionToolCallPart => part.type === "tool-call"
				)
			)
		);
		expect(forkedToolParts).toHaveLength(2);
		expect(
			new Set(forkedToolParts.map(({ toolBatch }) => toolBatch?.id)).size
		).toBe(1);
		expect(forkedToolParts[0]?.toolBatch?.id).not.toBe(
			modelStepId("fork-tool-batch-step")
		);
		expect(
			forkedToolParts.flatMap(({ toolBatch }) => toolBatch?.toolCallIds ?? [])
		).not.toContain(toolCallId("fork-parallel-first-call"));
	} finally {
		persistence.close();
	}
});

test("foreign writer contention reports session_in_use without reserving the operation ID", async () => {
	const persistence = createPersistence("busy-operation-fork");
	const sourceTurnId = agentTurnId("busy-fork-source-turn");
	try {
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("The first cut remains available."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const firstTerminal: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("busy-fork-first-terminal"),
			messages: [
				{
					id: sessionMessageId("busy-fork-first-terminal-message"),
					parts: [{ text: "First turn completed.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: firstTerminal,
			sessionId: created.id,
		});
		const secondTurnId = agentTurnId("busy-fork-second-turn");
		const secondUserMessage = createSessionUserMessage(
			"The retry selects the later valid cut.",
			{ submissionStatus: "processed" }
		);
		await persistence.store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: secondUserMessage,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: secondTurnId,
			}),
			sessionId: created.id,
		});
		const secondTerminal: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("busy-fork-second-terminal"),
			messages: [
				{
					id: sessionMessageId("busy-fork-second-terminal-message"),
					parts: [{ text: "Second turn completed.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_001, kind: "completed" },
			},
			turnId: secondTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: secondTerminal,
			sessionId: created.id,
		});

		const writer = await acquireSessionWriterLock(
			resolveLocalSessionLogRoot(
				path.join(temporaryRoot, "busy-operation-fork.sqlite")
			),
			created.id
		);
		try {
			await expect(
				invokeFork(
					persistence.store,
					created.id,
					{ recordId: firstTerminal.id },
					"busy-fork-reusable-operation"
				)
			).rejects.toMatchObject({ code: "session_in_use" });
		} finally {
			await writer.release();
		}

		const forked = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: secondTerminal.id },
			"busy-fork-reusable-operation"
		);
		expect(forked.created).toBe(true);
		expect(
			(await persistence.store.getSessionForkProvenance(forked.id))
				?.sourceRecordId
		).toBe(secondTerminal.id);
		await expect(
			invokeFork(
				persistence.store,
				created.id,
				{ recordId: firstTerminal.id },
				"busy-fork-reusable-operation"
			)
		).rejects.toMatchObject({ code: "session_operation_conflict" });
	} finally {
		persistence.close();
	}
});

test("an invalid checkpoint does not reserve a fork operation ID", async () => {
	const persistence = createPersistence("invalid-operation-fork");
	const sourceTurnId = agentTurnId("invalid-operation-source-turn");
	try {
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("The user record is not a fork cut."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const initialRecord = (
			await persistence.store.listSessionRecords(created.id)
		)[0];
		if (initialRecord === undefined) {
			throw new Error("Fork source did not persist its initial user record.");
		}
		const nonterminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("invalid-operation-nonterminal-record"),
			messages: [
				{
					id: sessionMessageId("invalid-operation-nonterminal-message"),
					parts: [
						{
							text: "This output is not a continuation boundary.",
							type: "text",
						},
					],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: { kind: "checkpoint" },
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: nonterminalRecord,
			sessionId: created.id,
		});
		await expect(
			invokeFork(
				persistence.store,
				created.id,
				{ recordId: nonterminalRecord.id },
				"invalid-checkpoint-reusable-operation"
			)
		).rejects.toMatchObject({ code: "session_checkpoint_invalid" });

		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("invalid-operation-terminal-record"),
			messages: [
				{
					id: sessionMessageId("invalid-operation-terminal-message"),
					parts: [{ text: "Now a valid terminal cut exists.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminalRecord,
			sessionId: created.id,
		});
		const forked = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: terminalRecord.id },
			"invalid-checkpoint-reusable-operation"
		);
		expect(forked.created).toBe(true);
	} finally {
		persistence.close();
	}
});

test("a retry after publication returns the fork created before a durability failure", async () => {
	const databasePath = path.join(temporaryRoot, "post-publish-fork.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	await fs.mkdir(logRoot, { recursive: true });
	const canonicalLogRoot = await fs.realpath(logRoot);
	let failPublicationSync = false;
	const persistence = createPersistence("post-publish-fork", {
		syncDirectory: async (directory, handle) => {
			if (failPublicationSync && directory === canonicalLogRoot) {
				failPublicationSync = false;
				throw new Error("injected post-publish directory sync failure");
			}
			await handle.sync();
		},
	});
	const sourceTurnId = agentTurnId("post-publish-source-turn");
	try {
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("Recover the already-published fork."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("post-publish-terminal-record"),
			messages: [
				{
					id: sessionMessageId("post-publish-terminal-message"),
					parts: [{ text: "The fork cut is ready.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminalRecord,
			sessionId: created.id,
		});
		failPublicationSync = true;
		let firstError: unknown;
		try {
			await invokeFork(
				persistence.store,
				created.id,
				{ recordId: terminalRecord.id },
				"post-publish-retry-operation"
			);
		} catch (error) {
			firstError = error;
		}
		expect(firstError).toBeInstanceOf(SessionLogError);
		if (!(firstError instanceof SessionLogError)) {
			throw new Error(
				"Fork publication failure did not expose its write state."
			);
		}
		expect(firstError.code).toBe("session_log_write_indeterminate");

		const retried = await invokeFork(
			persistence.createStore({}),
			created.id,
			{ recordId: terminalRecord.id },
			"post-publish-retry-operation"
		);
		expect(retried).toMatchObject({ created: false, id: firstError.sessionId });
		expect(await persistence.store.listSessionRecords(retried.id)).toHaveLength(
			2
		);
	} finally {
		persistence.close();
	}
});

test("fork provenance retains source submission failure without replaying it", async () => {
	const persistence = createPersistence("submission-provenance-fork");
	const sourceSubmissionId = toSubmissionId("source-failed-submission");
	const sourceMessage = createSessionUserMessage(
		"Keep the failed source submission as context.",
		{ submissionId: sourceSubmissionId },
		[],
		[],
		sessionMessageId("fork-failed-source-message")
	);
	try {
		const sourceTurnId = agentTurnId("fork-failed-source-turn");
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: sourceMessage,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const sourceRecord = (
			await persistence.store.listSessionRecords(created.id)
		)[0];
		if (sourceRecord === undefined) {
			throw new Error("Fork source did not persist its initial user record.");
		}
		await persistence.store.updateSessionSubmission({
			failure: "The source delivery failed.",
			messageId: sourceMessage.id,
			recordId: sourceRecord.id,
			sessionId: created.id,
			status: "failed",
			submissionId: sourceSubmissionId,
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("fork-failed-source-terminal"),
			messages: [
				{
					id: sessionMessageId("fork-failed-source-terminal-message"),
					parts: [{ text: "The source turn completed.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminalRecord,
			sessionId: created.id,
		});

		const forked = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: terminalRecord.id },
			"fork-failed-source-provenance"
		);
		const inheritedUser = (
			await persistence.store.listSessionRecords(forked.id)
		)[0]?.messages[0];
		expect(inheritedUser?.metadata?.submissionId).not.toBe(sourceSubmissionId);
		expect(inheritedUser?.metadata?.submissionStatus).toBe("processed");
		expect(inheritedUser?.metadata?.submissionFailure).toBeUndefined();
		expect(
			await persistence.store.getSessionForkProvenance(forked.id)
		).toMatchObject({
			inheritedSubmissions: [
				{
					failure: "The source delivery failed.",
					sourceMessageId: sourceMessage.id,
					sourceRecordId: sourceRecord.id,
					sourceSubmissionId,
					status: "failed",
					targetMessageId: inheritedUser?.id,
					targetSubmissionId: inheritedUser?.metadata?.submissionId,
				},
			],
		});
	} finally {
		persistence.close();
	}
});

test("fork cut remaps compaction references, captures source metadata and excludes pending suffix", async () => {
	const persistence = createPersistence("compaction-cut-fork");
	const sourceMessageId = sessionMessageId("fork-cut-source-message");
	const sourceSubmissionId = toSubmissionId("fork-cut-source-submission");
	const selectedModel = providerModelSelectionFixture("openai/gpt-4.1");
	try {
		const sourceTurnId = agentTurnId("fork-cut-source-turn");
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage(
				"Retain this prefix.",
				{
					submissionId: sourceSubmissionId,
					submissionStatus: "processed",
				},
				[],
				[],
				sourceMessageId
			),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		await persistence.store.updateSession(created.id, {
			title: "Metadata at the fork cut",
		});
		const sourceCompactionId = compactionId("fork-cut-source-compaction");
		await persistence.store.appendCompaction({
			firstKeptUiMessageId: sourceMessageId,
			id: sourceCompactionId,
			sessionId: created.id,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [sourceMessageId],
				formatVersion: 1,
				text: "The retained prefix summary.",
			},
			throughMessageUiId: sourceMessageId,
			tokensBefore: 10,
			estimatedTokensAfter: 5,
			trigger: "manual",
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("fork-cut-terminal-record"),
			messages: [
				{
					id: sessionMessageId("fork-cut-terminal-message"),
					parts: [{ text: "The cut is valid.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminalRecord,
			sessionId: created.id,
			sessionModel: selectedModel,
		});
		const pendingMessage = createSessionUserMessage(
			"Do not include this message after the selected cut.",
			{
				submissionId: toSubmissionId("fork-cut-pending-suffix"),
				submissionStatus: "pending",
			},
			[],
			[],
			sessionMessageId("fork-cut-pending-suffix-message")
		);
		await persistence.store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: pendingMessage,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("fork-cut-pending-suffix-turn"),
			}),
			sessionId: created.id,
		});

		const forked = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: terminalRecord.id },
			"fork-cut-remapped-compaction"
		);
		const forkRecords = await persistence.store.listSessionRecords(forked.id);
		const forkUserMessage = forkRecords[0]?.messages[0];
		expect(forkRecords).toHaveLength(2);
		expect(
			forkRecords.flatMap((record) => record.messages).map(({ id }) => id)
		).not.toContain(pendingMessage.id);
		expect(forkUserMessage?.metadata?.submissionStatus).toBe("processed");
		const compactions = await persistence.store.getCompactions(forked.id);
		expect(compactions).toHaveLength(1);
		expect(compactions[0]).toMatchObject({
			firstKeptUiMessageId: forkUserMessage?.id,
			throughMessageUiId: forkUserMessage?.id,
			summary: {
				coveredMessageIds: [forkUserMessage?.id],
			},
		});
		expect(compactions[0]?.id).not.toBe(sourceCompactionId);
		const forkSession = (await persistence.store.listSessions()).find(
			({ id }) => id === forked.id
		);
		expect(forkSession).toMatchObject({
			model: selectedModel,
			title: "Metadata at the fork cut",
		});
	} finally {
		persistence.close();
	}
});

test("a cut drops later compaction and selection state while retaining full history context", async () => {
	const persistence = createPersistence("compaction-after-cut");
	const selectedAtCut = providerModelSelectionFixture("openai/gpt-4.1");
	const selectedAfterCut = providerModelSelectionFixture("openai/gpt-5.1");
	const initialMessageId = sessionMessageId("compaction-after-cut-user");
	try {
		const turnId = agentTurnId("compaction-after-cut-turn");
		const terminalMessageId = sessionMessageId(
			"compaction-after-cut-terminal-message"
		);
		const created = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage(
				"Retain the complete history before this cut.",
				undefined,
				[],
				[],
				initialMessageId
			),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId,
		});
		const terminal: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("compaction-after-cut-terminal"),
			messages: [
				{
					id: terminalMessageId,
					parts: [
						{ text: "This checkpoint is before compaction.", type: "text" },
					],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminal,
			sessionId: created.id,
			sessionModel: selectedAtCut,
		});
		await persistence.store.appendCompaction({
			firstKeptUiMessageId: initialMessageId,
			id: compactionId("compaction-after-cut-summary"),
			sessionId: created.id,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [initialMessageId, terminalMessageId],
				formatVersion: 1,
				text: "Do not publish this later compaction into the fork.",
			},
			throughMessageUiId: terminalMessageId,
			tokensBefore: 20,
			estimatedTokensAfter: 8,
			trigger: "manual",
		});
		await persistence.store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: createSessionUserMessage(
					"This input is after the rewind cut.",
					undefined,
					[],
					[],
					sessionMessageId("compaction-after-cut-suffix")
				),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("compaction-after-cut-suffix-turn"),
			}),
			sessionId: created.id,
			sessionModel: selectedAfterCut,
		});

		const forked = await invokeFork(
			persistence.store,
			created.id,
			{ recordId: terminal.id },
			"compaction-after-cut-fork"
		);
		const forkRecords = await persistence.store.listSessionRecords(forked.id);
		const forkMessages = forkRecords.flatMap((record) => record.messages);
		expect(await persistence.store.getCompactions(forked.id)).toEqual([]);
		expect(forkRecords).toHaveLength(2);
		expect(forkMessages.map(({ id }) => id)).not.toContain(
			sessionMessageId("compaction-after-cut-suffix")
		);
		expect((await persistence.store.getSession(forked.id)).model).toEqual(
			selectedAtCut
		);
		expect((await persistence.store.getSession(created.id)).model).toEqual(
			selectedAfterCut
		);
	} finally {
		persistence.close();
	}
});

test("fork replay rejects dangling record, submission, and compaction provenance references", async () => {
	const persistence = createPersistence("dangling-fork-provenance");
	try {
		const sourceTurnId = agentTurnId("dangling-fork-source-turn");
		const source = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("Fork replay reference source.", {
				submissionId: toSubmissionId("dangling-fork-source-submission"),
				submissionStatus: "processed",
			}),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("dangling-fork-source-record"),
			messages: [
				{
					id: sessionMessageId("dangling-fork-source-message"),
					parts: [{ text: "A completed source turn.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminalRecord,
			sessionId: source.id,
		});
		const forked = await invokeFork(
			persistence.store,
			source.id,
			{ recordId: terminalRecord.id },
			"dangling-fork-provenance-operation"
		);
		const targetPath = path.join(
			persistence.logRoot,
			forked.id,
			"session.jsonl"
		);
		const targetBytes = await Bun.file(targetPath).bytes();
		const targetState = decodeSessionLog(forked.id, targetBytes);
		const forkEntry = targetState.entries.find(
			({ envelope }) => envelope.type === "session.forked"
		);
		const targetUserRecord = targetState.entries
			.flatMap(({ envelope }) => {
				let candidate: unknown;
				if (envelope.type === "session.created") {
					candidate = envelope.payload.initialRecord;
				} else if (envelope.type === "record.committed") {
					candidate = envelope.payload.record;
				}
				return isSessionRecord(candidate) ? [candidate] : [];
			})
			.find((record) => record.messages.some(({ role }) => role === "user"));
		const targetUserMessage = targetUserRecord?.messages.find(
			({ role }) => role === "user"
		);
		if (targetUserRecord === undefined || targetUserMessage === undefined) {
			throw new Error("The fork log has no inherited user record.");
		}
		if (forkEntry?.envelope.type !== "session.forked") {
			throw new Error("The target log has no fork provenance entry.");
		}
		const inheritedSubmissions =
			forkEntry.envelope.payload.inheritedSubmissions;
		if (
			!Array.isArray(inheritedSubmissions) ||
			inheritedSubmissions.length === 0
		) {
			throw new Error("The fork provenance has no inherited submissions.");
		}
		const firstSubmission: unknown = inheritedSubmissions[0];
		if (
			typeof firstSubmission !== "object" ||
			firstSubmission === null ||
			Array.isArray(firstSubmission)
		) {
			throw new Error("The inherited Submission reference is not an object.");
		}
		const invalidTargetSubmission = {
			...firstSubmission,
			targetSubmissionId: "missing-target-submission",
		};
		const invalidPayloads = [
			{
				...forkEntry.envelope.payload,
				targetMessageId: "missing-target-message",
			},
			{
				...forkEntry.envelope.payload,
				targetRecordId: String(targetUserRecord.id),
				targetMessageId: String(targetUserMessage.id),
				targetTurnId: String(targetUserRecord.turnId),
			},
			{
				...forkEntry.envelope.payload,
				inheritedCompactionIds: ["missing-target-compaction"],
			},
			{
				...forkEntry.envelope.payload,
				inheritedSubmissions: [
					invalidTargetSubmission,
					...inheritedSubmissions.slice(1),
				],
			},
			{
				...forkEntry.envelope.payload,
				inheritedSubmissions: [
					inheritedSubmissions[0],
					inheritedSubmissions[0],
				],
			},
		];
		for (const payload of invalidPayloads) {
			const corruptedEntry = createSessionLogEvent({
				operationId: forkEntry.envelope.operationId,
				payload,
				previousHash: forkEntry.envelope.previousHash,
				sequence: forkEntry.envelope.sequence,
				sessionId: forked.id,
				timestamp: forkEntry.envelope.timestamp,
				type: "session.forked",
			});
			const corruptedLine = encodeSessionLogLine(corruptedEntry);
			const corruptedBytes = new Uint8Array(
				forkEntry.startOffset + corruptedLine.byteLength
			);
			corruptedBytes.set(targetBytes.subarray(0, forkEntry.startOffset));
			corruptedBytes.set(corruptedLine, forkEntry.startOffset);

			let failure: unknown;
			try {
				decodeSessionLog(forked.id, corruptedBytes);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(SessionLogError);
			expect(failure).toMatchObject({
				code: "session_log_corrupt",
				offset: forkEntry.startOffset,
				sequence: forkEntry.envelope.sequence,
			});
		}
	} finally {
		persistence.close();
	}
});

test("fork provenance waits for a concurrent source append before declaring it unavailable", async () => {
	const appendStarted = Promise.withResolvers<void>();
	const releaseAppend = Promise.withResolvers<void>();
	let sourceLogPath: string | undefined;
	let lastWriteFilePath: string | undefined;
	let pauseSourceAppend = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			lastWriteFilePath = filePath;
			if (pauseSourceAppend && filePath === sourceLogPath) {
				pauseSourceAppend = false;
				const result = await handle.write(
					bytes,
					offset,
					Math.max(1, Math.floor(length / 2)),
					position
				);
				appendStarted.resolve();
				await releaseAppend.promise;
				return result.bytesWritten;
			}
			const result = await handle.write(bytes, offset, length, position);
			return result.bytesWritten;
		},
	};
	const persistence = createPersistence(
		"fork-provenance-concurrent-append",
		fileIo
	);
	let appendPromise: Promise<unknown> | undefined;
	try {
		const sourceTurnId = agentTurnId("fork-provenance-live-source-turn");
		const source = await persistence.store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("Keep fork provenance readable."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("fork-provenance-live-source-record"),
			messages: [
				{
					id: sessionMessageId("fork-provenance-live-source-message"),
					parts: [{ text: "The fork boundary is durable.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: { finishedAt: 1_800_000_000_000, kind: "completed" },
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		await persistence.store.commitSessionRecord({
			record: terminalRecord,
			sessionId: source.id,
		});
		const forked = await invokeFork(
			persistence.store,
			source.id,
			{ recordId: terminalRecord.id },
			"fork-provenance-concurrent-append-operation"
		);
		sourceLogPath = await fs.realpath(
			path.join(persistence.logRoot, source.id, "session.jsonl")
		);
		pauseSourceAppend = true;
		appendPromise = persistence.store.commitSessionRecord({
			record: {
				agentId: agentId("build"),
				id: sessionRecordId("fork-provenance-later-source-record"),
				messages: [
					{
						id: sessionMessageId("fork-provenance-later-source-message"),
						parts: [{ text: "A later source checkpoint.", type: "text" }],
						role: "assistant",
					},
				],
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				outcome: {
					kind: "assistant",
					terminal: { finishedAt: 1_800_000_000_001, kind: "completed" },
				},
				turnId: agentTurnId("fork-provenance-later-source-turn"),
				version: SESSION_RECORD_VERSION,
			},
			sessionId: source.id,
		});
		const appendPaused = await Promise.race([
			appendStarted.promise.then(() => true),
			Bun.sleep(1000).then(() => false),
		]);
		if (!appendPaused) {
			throw new Error(
				`Source append did not pause at ${sourceLogPath}; last write was ${lastWriteFilePath}.`
			);
		}
		const provenancePromise = persistence.store.getSessionForkProvenance(
			forked.id
		);
		await Bun.sleep(30);
		releaseAppend.resolve();
		await appendPromise;
		await expect(provenancePromise).resolves.toMatchObject({
			sourceAvailability: "available",
			sourceSessionId: source.id,
		});
	} finally {
		releaseAppend.resolve();
		await appendPromise?.catch(() => undefined);
		persistence.close();
	}
});

test("forking a terminal Agent Turn publishes an independent remapped prefix and retries to the same Session", async () => {
	const persistence = createPersistence("terminal-prefix");
	const store = persistence.store;
	try {
		const sourceTurnId = agentTurnId("fork-source-turn");
		const fileObservationStore = store.fileObservationStore;
		if (fileObservationStore === undefined) {
			throw new Error("Fork persistence did not expose file observations.");
		}
		const created = await store.createSession({
			agent: agentId("build"),
			message: createSessionUserMessage("Keep this as inherited context."),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: sourceTurnId,
		});
		expect(created.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		const terminalRecord: SessionRecord = {
			agentId: agentId("build"),
			id: sessionRecordId("fork-source-terminal-record"),
			messages: [
				{
					id: sessionMessageId("fork-source-terminal-message"),
					parts: [{ text: "The turn completed.", type: "text" }],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: {
				kind: "assistant",
				terminal: {
					finishedAt: 1_800_000_000_000,
					kind: "completed",
					usage: { inputTokens: 17, outputTokens: 5 },
				},
			},
			turnId: sourceTurnId,
			version: SESSION_RECORD_VERSION,
		};
		const committed = await store.commitSessionRecord({
			record: terminalRecord,
			sessionId: created.id,
		});
		expect(committed).toMatchObject({ kind: "committed", projection: "ready" });
		const sourceRecords = await store.listSessionRecords(created.id);
		expect(sourceRecords).toHaveLength(2);

		const checkpoint = { recordId: terminalRecord.id };
		const sourceObservation = {
			createdAt: 1_800_000_000_000,
			fileVersion: "a".repeat(32) as FileVersion,
			id: "fork-source-observation",
			path: "README.md",
			sessionId: created.id,
			seenLines: [{ startLine: 1 }],
			snapshotAvailable: false,
		};
		await fileObservationStore.saveObservation(sourceObservation);
		const forked = await invokeFork(
			store,
			created.id,
			checkpoint,
			"fork-terminal-prefix"
		);
		const forkRecords = await store.listSessionRecords(forked.id);
		const forkMessages = forkRecords.flatMap((record) => record.messages);

		expect(forked.id).not.toBe(created.id);
		expect(forked.created).toBe(true);
		expect(forked.writeOutcome).toMatchObject({
			kind: "committed",
			operationId: "fork-terminal-prefix",
			projection: "ready",
		});
		expect(forkRecords).toHaveLength(2);
		expect(forkRecords.map(({ id }) => id)).not.toContain(sourceRecords[0]?.id);
		expect(forkRecords.map(({ id }) => id)).not.toContain(sourceRecords[1]?.id);
		expect(forkRecords.map(({ turnId }) => turnId)).not.toContain(sourceTurnId);
		expect(forkMessages.map(({ id }) => id)).not.toContain(
			sourceRecords[0]?.messages[0]?.id
		);
		expect(forkMessages.map(({ id }) => id)).not.toContain(
			terminalRecord.messages[0]?.id
		);
		expect(await store.listSessionRecords(created.id)).toEqual(sourceRecords);
		expect(
			await fileObservationStore.getLatestObservation(
				forked.id,
				sourceObservation.path
			)
		).toBeNull();
		expect(
			await fileObservationStore.getLatestObservation(
				created.id,
				sourceObservation.path
			)
		).toEqual(sourceObservation);
		const statistics = await store.getSessionStatistics(forked.id);
		expect(statistics.usage.actual.contributionCount).toBe(0);
		expect(statistics.usage.inherited).toMatchObject({
			contributionCount: 1,
			inputTokens: 17,
			outputTokens: 5,
		});
		const combinedUsage = aggregateSessionStatisticsUsage([
			await store.getSessionStatistics(created.id),
			statistics,
		]);
		expect(combinedUsage.actual).toMatchObject({
			contributionCount: 1,
			inputTokens: 17,
			outputTokens: 5,
		});
		expect(combinedUsage.inherited).toMatchObject({
			contributionCount: 0,
			inputTokens: null,
		});

		const provenance = await store.getSessionForkProvenance(forked.id);
		expect(provenance).toMatchObject({
			sourceAvailability: "available",
			sourceRecordId: terminalRecord.id,
			sourceSessionId: created.id,
		});

		const retried = await invokeFork(
			store,
			created.id,
			checkpoint,
			"fork-terminal-prefix"
		);
		expect(retried.id).toBe(forked.id);
		expect(retried.created).toBe(false);
		expect(retried.writeOutcome).toMatchObject({
			kind: "committed",
			operationId: "fork-terminal-prefix",
		});

		const deleted = await store.deleteSession(created.id);
		expect(deleted).toMatchObject({ kind: "committed", projection: "ready" });
		expect(await store.listSessionRecords(forked.id)).toHaveLength(2);
		expect(await store.getSessionForkProvenance(forked.id)).toMatchObject({
			sourceAvailability: "unavailable",
			sourceSessionId: created.id,
		});
	} finally {
		persistence.close();
	}
});
