import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import type {
	AgentTurnOutcomeRecord,
	OperationalFailure,
	SessionMessageRecord,
	SessionRecord,
} from "@wincode/agent-core";
import { isUndefined } from "@wincode/utils";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { SessionMessage } from "@/modules/sessions/message";
import { createDatabase } from "@/modules/sessions/storage/client";
import {
	createDrizzleSessionStore,
	type DrizzleSessionStore,
} from "@/modules/sessions/storage/drizzle-session-store";
import {
	buildUserSessionRecord,
	SessionRecordInvariantError,
} from "@/modules/sessions/storage/session-record";
import { projectSessionRecords } from "@/modules/sessions/transcript-projection";
import type { SessionId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	attachmentId,
	modelId,
	sessionMessageId,
	sessionRecordId,
	sessionUsageEntryId,
	toolCallId,
} from "../support/identifiers";

const model: ProviderModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};

const userMessage = (text: string, id = "msg-user"): SessionMessage => ({
	id: sessionMessageId(id),
	parts: [{ text, type: "text" }],
	role: "user",
});

const messageRecord = (
	id: string,
	role: "assistant" | "user",
	text: string,
	metadata?: SessionMessageRecord["metadata"]
): SessionMessageRecord => ({
	id: sessionMessageId(id),
	...(isUndefined(metadata) ? {} : { metadata }),
	parts: [{ text, type: "text" }],
	role,
});

const failure: OperationalFailure = {
	code: "unknown",
	message: "The model request failed.",
	retry: "never",
	source: "model",
	version: 1,
};

const assistantRecord = (
	id: string,
	text: string,
	terminal: AgentTurnOutcomeRecord = {
		finishedAt: 200,
		kind: "completed",
		usage: { inputTokens: 10, outputTokens: 5 },
	}
): SessionRecord => ({
	agentId: agentId("build"),
	id: sessionRecordId(id),
	messages: [
		messageRecord(id.replace("record", "assistant"), "assistant", text, {
			agent: agentId("build"),
			model,
		}),
	],
	model,
	outcome: { kind: "assistant", terminal },
	turnId: agentTurnId(`turn-${id}`),
	version: 1,
});

const failedRecord = (id: string): SessionRecord =>
	assistantRecord(id, failure.message, {
		failure,
		finishedAt: 300,
		kind: "failed",
	});

const cancelledRecord = (id: string): SessionRecord =>
	assistantRecord(id, "The Agent Turn was cancelled.", {
		failure: {
			code: "cancelled",
			message: "The Agent Turn was cancelled.",
			retry: "never",
			source: "runtime",
			version: 1,
		},
		finishedAt: 400,
		kind: "cancelled",
	});

const toolRecord = (id: string): SessionRecord => ({
	agentId: agentId("build"),
	id: sessionRecordId(id),
	messages: [
		{
			id: sessionMessageId(`tool-${id}`),
			parts: [
				{
					input: { command: "git status" },
					outcome: { kind: "success", output: { exitCode: 0 } },
					sequence: 1,
					toolCallId: toolCallId(`call-${id}`),
					toolName: "shell",
					type: "tool-call",
				},
			],
			role: "assistant",
		},
	],
	model,
	outcome: { kind: "tool" },
	turnId: agentTurnId(`turn-${id}`),
	version: 1,
});

type TestStore = {
	databasePath: string;
	storage: DrizzleSessionStore;
};

type CreatedSession = {
	id: SessionId;
	initialRecord: SessionRecord;
};

const createTestStore = async (): Promise<TestStore> => {
	const dir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-conversation-record-")
	);
	const databasePath = path.join(dir, "conversation.sqlite");
	const { db } = createDatabase(databasePath);
	const storage = createDrizzleSessionStore(db, {
		attachmentRoot: path.join(dir, "attachments"),
	});
	return { databasePath, storage };
};

const createSession = async (
	storage: DrizzleSessionStore,
	text = "hello"
): Promise<CreatedSession> => {
	const { id } = await storage.createSession({
		agent: agentId("build"),
		message: userMessage(text),
		model,
		turnId: agentTurnId(`turn-initial-${text}`),
	});
	const [initialRecord] = await storage.listSessionRecords(id);
	if (isUndefined(initialRecord)) {
		throw new Error("The initial user record was not persisted.");
	}
	return { id, initialRecord };
};

test("creates an SDK-ready empty Session without inventing a user Submission", async () => {
	const { storage } = await createTestStore();
	const { id } = await storage.createEmptySession({ model });

	expect(await storage.listSessionRecords(id)).toEqual([]);
	expect(await storage.getSession(id)).toMatchObject({
		id,
		lastMessageAt: null,
		model,
		title: "Untitled Session",
	});
});

test("persists warm usage exactly once outside Session Records", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage, "warm-session");
	const input = {
		costUsd: null,
		id: sessionUsageEntryId("warm-usage-1"),
		kind: "cache-warm" as const,
		model,
		sessionId: id,
		usage: {
			cacheReadTokens: 20,
			inputTokens: 20,
			outputTokens: 1,
			totalTokens: 21,
		},
	};

	const saved = await storage.createSessionUsageEntry(input);
	const retried = await storage.createSessionUsageEntry(input);

	expect(retried).toEqual(saved);
	expect(await storage.listSessionUsageEntries(id)).toEqual([saved]);
	expect(await storage.listSessionRecords(id)).toEqual([initialRecord]);
});

test("persists the accepted user message as an ordinary record", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage, "first");

	expect(initialRecord.outcome).toEqual({ kind: "user" });
	expect(initialRecord.messages).toEqual([
		{
			id: sessionMessageId("msg-user"),
			parts: [{ text: "first", type: "text" }],
			role: "user",
		},
	]);
	expect(await storage.listSessionRecords(id)).toEqual([initialRecord]);
});
test("round-trips the logical user link for retried assistant rows", async () => {
	const { storage } = await createTestStore();
	const { id } = await createSession(storage);
	const assistant = assistantRecord("record-retry", "retried");
	const message = assistant.messages[0];
	if (isUndefined(message)) {
		throw new Error("The assistant record did not contain a message.");
	}
	const retriedRecord: SessionRecord = {
		...assistant,
		messages: [
			{
				...message,
				metadata: {
					...message.metadata,
					sourceUserMessageId: sessionMessageId("msg-user"),
				},
			},
		],
	};

	await storage.commitSessionRecord({
		record: retriedRecord,
		sessionId: id,
	});

	const records = await storage.listSessionRecords(id);
	const persisted = records.find(
		({ id: recordId }) => recordId === retriedRecord.id
	);
	expect(persisted?.messages[0]?.metadata?.sourceUserMessageId).toBe(
		sessionMessageId("msg-user")
	);
	expect(projectSessionRecords([retriedRecord])[0]?.metadata).toMatchObject({
		sourceUserMessageId: "msg-user",
	});
});

test("reopens durable records without reconstructing or running execution", async () => {
	const { databasePath, storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage);
	const assistant = assistantRecord("record-assistant", "done");
	await storage.commitSessionRecord({ record: assistant, sessionId: id });

	const { db } = createDatabase(databasePath);
	const reopened = createDrizzleSessionStore(db, {
		attachmentRoot: path.join(os.tmpdir(), "wincode-reopened-attachments"),
	});

	expect(await reopened.listSessionRecords(id)).toEqual([
		initialRecord,
		assistant,
	]);
});

test("round-trips assistant and tool records independently", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage);
	const tool = toolRecord("record-tool");
	const assistant = assistantRecord("record-assistant", "tool result");

	await storage.commitSessionRecord({ record: tool, sessionId: id });
	await storage.commitSessionRecord({ record: assistant, sessionId: id });

	expect(await storage.listSessionRecords(id)).toEqual([
		initialRecord,
		tool,
		assistant,
	]);
});

test("reopens effective turn records with their trusted Plugin owner provenance", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage);
	const sourceBoundModel: ProviderModelSelection = {
		...model,
		pluginProviderSource: {
			pluginId: "trusted-provider-plugin",
			sourceIdentity: "/trusted/plugins/provider.ts",
		},
	};
	const sourceBoundRecord: SessionRecord = {
		...assistantRecord("record-plugin-owner", "owner-bound"),
		messages: [
			messageRecord("assistant-plugin-owner", "assistant", "owner-bound", {
				agent: agentId("build"),
				model: sourceBoundModel,
			}),
		],
		model: sourceBoundModel,
	};

	await storage.commitSessionRecord({
		record: sourceBoundRecord,
		sessionId: id,
	});

	const records = await storage.listSessionRecords(id);
	expect(records).toEqual([initialRecord, sourceBoundRecord]);
	expect(projectSessionRecords(records)[1]?.metadata?.model).toEqual(
		sourceBoundModel
	);
});

test("persists an optional Plugin tool without adding a built-in tool name", async () => {
	const { storage } = await createTestStore();
	const { id } = await createSession(storage);
	const source = toolRecord("record-plugin-tool");
	const message = source.messages[0];
	const part = message?.parts[0];
	if (message === undefined || part?.type !== "tool-call") {
		throw new Error("Expected a tool call in the test record.");
	}
	const pluginRecord: SessionRecord = {
		...source,
		messages: [
			{
				...message,
				parts: [{ ...part, toolName: "jira:create_issue" }],
			},
		],
	};

	await storage.commitSessionRecord({ record: pluginRecord, sessionId: id });

	const storedTool = projectSessionRecords(
		await storage.listSessionRecords(id)
	)[1]?.parts[0];
	expect(storedTool).toMatchObject({
		toolName: "jira:create_issue",
		type: "dynamic-tool",
	});
});

test("round-trips a failed assistant record with its safe failure", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage);
	const record = failedRecord("record-failed");

	await storage.commitSessionRecord({ record, sessionId: id });

	expect(await storage.listSessionRecords(id)).toEqual([initialRecord, record]);
});

test("round-trips a cancelled assistant record without an interrupted badge", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage);
	const record = cancelledRecord("record-cancelled");

	await storage.commitSessionRecord({ record, sessionId: id });

	expect(await storage.listSessionRecords(id)).toEqual([initialRecord, record]);
	expect(projectSessionRecords([record])[0]?.metadata).toEqual({
		agent: agentId("build"),
		model,
		terminalOutcome: "cancelled",
	});
});

test("reopening records preserves unknown Provider Model identities and their measured usage", () => {
	const unknownModel = {
		modelId: modelId("plugin-owned-model"),
		providerId: "plugin-owned-provider",
	};
	const record: SessionRecord = {
		...assistantRecord("record-provider-model", "done"),
		model: { ...unknownModel, thinkingLevel: "high" },
		messages: [
			messageRecord("assistant-provider-model", "assistant", "done", {
				agent: agentId("build"),
				model: unknownModel,
				thinkingLevel: "high",
				usage: { inputTokens: 17, outputTokens: 6 },
			}),
		],
	};

	expect(projectSessionRecords([record])[0]?.metadata).toEqual({
		agent: agentId("build"),
		model: unknownModel,
		thinkingLevel: "high",
		usage: { inputTokens: 17, outputTokens: 6 },
	});
});

test("reopening a record preserves its ThinkingLevel without Provider metadata lookup", () => {
	const record: SessionRecord = {
		...assistantRecord("record-unsupported-mode", "done"),
		messages: [
			messageRecord("assistant-unsupported-mode", "assistant", "done", {
				agent: agentId("build"),
				model,
				thinkingLevel: "minimal",
				usage: { inputTokens: 10, outputTokens: 5 },
			}),
		],
	};

	expect(projectSessionRecords([record])[0]?.metadata).toEqual({
		agent: agentId("build"),
		model,
		thinkingLevel: "minimal",
		usage: { inputTokens: 10, outputTokens: 5 },
	});
});

test("keeps records isolated per session and per workspace", async () => {
	const dir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-conversation-record-")
	);
	const databasePath = path.join(dir, "conversation.sqlite");
	const { db } = createDatabase(databasePath);
	const firstWorkspace = createDrizzleSessionStore(db, {
		attachmentRoot: path.join(dir, "attachments-a"),
		workspaceRoot: path.join(dir, "workspace-a"),
	});
	const secondWorkspace = createDrizzleSessionStore(db, {
		attachmentRoot: path.join(dir, "attachments-b"),
		workspaceRoot: path.join(dir, "workspace-b"),
	});
	const sessionA = await createSession(firstWorkspace);
	const sessionB = await createSession(firstWorkspace, "other");

	await firstWorkspace.commitSessionRecord({
		record: assistantRecord("record-a", "hello"),
		sessionId: sessionA.id,
	});

	expect(await firstWorkspace.listSessionRecords(sessionA.id)).toHaveLength(2);
	expect(await firstWorkspace.listSessionRecords(sessionB.id)).toHaveLength(1);
	expect(await secondWorkspace.listSessionRecords(sessionA.id)).toEqual([]);
	await expect(
		secondWorkspace.commitSessionRecord({
			record: assistantRecord("record-b", "hello"),
			sessionId: sessionA.id,
		})
	).rejects.toThrow("Session not found");
});

test("orders concurrently committed records by their allocated position", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage);
	const first = assistantRecord("record-1", "one");
	const second = assistantRecord("record-2", "two");
	const third = failedRecord("record-3");

	await Promise.all([
		storage.commitSessionRecord({ record: first, sessionId: id }),
		storage.commitSessionRecord({ record: second, sessionId: id }),
		storage.commitSessionRecord({ record: third, sessionId: id }),
	]);

	expect(await storage.listSessionRecords(id)).toEqual([
		initialRecord,
		first,
		second,
		third,
	]);
});

test("rejects malformed records without partial durable state", async () => {
	const { storage } = await createTestStore();
	const { id, initialRecord } = await createSession(storage);
	const malformed: SessionRecord = fromAny({
		...assistantRecord("record-invalid", "bad"),
		outcome: { kind: "assistant", terminal: { finishedAt: 1, kind: "failed" } },
	});

	await expect(
		storage.commitSessionRecord({ record: malformed, sessionId: id })
	).rejects.toBeInstanceOf(SessionRecordInvariantError);
	expect(await storage.listSessionRecords(id)).toEqual([initialRecord]);

	await storage.commitSessionRecord({
		record: assistantRecord("record-valid", "good"),
		sessionId: id,
	});
	expect(await storage.listSessionRecords(id)).toHaveLength(2);
});

test("deletes Conversation Records with their session", async () => {
	const { storage } = await createTestStore();
	const { id } = await createSession(storage);
	await storage.commitSessionRecord({
		record: assistantRecord("record-1", "hello"),
		sessionId: id,
	});

	await storage.deleteSession(id);

	expect(await storage.listSessionRecords(id)).toEqual([]);
});

test("projects user attachments and metadata into stable transcript messages", () => {
	const attachmentReferenceId = `v1-${"a".repeat(64)}`;
	const userRecord: SessionRecord = {
		agentId: agentId("build"),
		id: sessionRecordId("record-user"),
		messages: [
			{
				id: sessionMessageId("user-1"),
				metadata: {
					agent: agentId("build"),
					model,
					skill: {
						contentHash: "hash-1",
						name: "review",
						source: "explicit",
					},
				},
				parts: [
					{ text: "Review this file", type: "text" },
					{
						attachmentId: attachmentId(attachmentReferenceId),
						byteLength: 3,
						filename: "notes.txt",
						mediaType: "text/plain",
						type: "attachment-reference",
					},
					{
						data: {
							byteLength: 5,
							content: "const x = 1;",
							kind: "file",
							path: "src/index.ts",
							truncated: false,
						},
						type: "file-mention",
					},
				],
				role: "user",
			},
		],
		model,
		outcome: { kind: "user" },
		turnId: agentTurnId("turn-user"),
		version: 1,
	};
	const primaryAssistant = assistantRecord("record-primary", "parent result");

	const projected = projectSessionRecords([userRecord, primaryAssistant]);
	const [user] = projected;
	expect(projected.map(({ id }) => id)).toEqual([
		sessionMessageId("user-1"),
		sessionMessageId("assistant-primary"),
	]);
	expect(user).toMatchObject({
		id: sessionMessageId("user-1"),
		metadata: {
			agent: agentId("build"),
			model,
			skill: {
				contentHash: "hash-1",
				name: "review",
				source: "explicit",
			},
		},
	});
	expect(user?.parts).toContainEqual({
		attachmentId: attachmentId(attachmentReferenceId),
		byteLength: 3,
		filename: "notes.txt",
		mediaType: "text/plain",
		type: "file",
		url: `attachment://${attachmentReferenceId}`,
	});
	expect(user?.parts).toContainEqual({
		data: {
			byteLength: 5,
			content: "const x = 1;",
			kind: "file",
			path: "src/index.ts",
			truncated: false,
		},
		type: "data-fileMention",
	});
});

test("projects a failed assistant row as its safe transcript message", () => {
	const projected = projectSessionRecords([failedRecord("record-failed")]);

	expect(projected).toEqual([
		{
			id: sessionMessageId("assistant-failed"),
			metadata: {
				agent: agentId("build"),
				model,
				terminalOutcome: "failed",
			},
			parts: [{ text: failure.message, type: "text" }],
			role: "assistant",
		},
	]);
});

test("restores a Plugin Provider selection with its trusted source owner", async () => {
	const { storage } = await createTestStore();
	const ownerBoundModel: ProviderModelSelection = {
		modelId: modelId("shared-model"),
		pluginProviderSource: {
			pluginId: "trusted-plugin",
			sourceIdentity: "/trusted/plugins/provider.ts",
		},
		providerId: "shared_provider",
	};
	const { id } = await storage.createEmptySession({ model: ownerBoundModel });
	const restored = await storage.getSession(id);
	expect(restored.model).toEqual(ownerBoundModel);

	const record = buildUserSessionRecord({
		agentId: agentId("build"),
		message: {
			...userMessage("use the selected Plugin Provider"),
			metadata: { model: ownerBoundModel },
		},
		model: ownerBoundModel,
		turnId: agentTurnId("turn-plugin-owner"),
	});
	await storage.commitSessionRecord({ record, sessionId: id });
	const [persisted] = await storage.listSessionRecords(id);
	expect(persisted?.messages[0]?.metadata?.model).toEqual(ownerBoundModel);
	expect(projectSessionRecords([record])[0]?.metadata?.model).toEqual(
		ownerBoundModel
	);
});

test("round-trips the Agent Turn a Steering Message joined", async () => {
	const { storage } = await createTestStore();
	const { id } = await createSession(storage);
	const steering: SessionRecord = {
		...buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: sessionMessageId("msg-steer"),
				metadata: { joinedTurnId: agentTurnId("turn-joined") },
				parts: [{ text: "use the cache instead", type: "text" }],
				role: "user",
			},
			model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
			turnId: agentTurnId("turn-joined"),
		}),
	};
	await storage.commitSessionRecord({ record: steering, sessionId: id });

	const records = await storage.listSessionRecords(id);
	const persisted = records.find(
		({ id: recordId }) => recordId === steering.id
	);
	expect(persisted?.messages[0]?.metadata?.joinedTurnId).toBe(
		agentTurnId("turn-joined")
	);
	// A reopened session still groups the message into the turn it joined
	// instead of letting it open a turn of its own.
	expect(projectSessionRecords([steering])[0]?.metadata).toMatchObject({
		joinedTurnId: "turn-joined",
	});
});
