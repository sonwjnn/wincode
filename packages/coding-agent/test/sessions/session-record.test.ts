import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import type {
	AgentTurnOutcomeRecord,
	OperationalFailure,
	SessionMessageRecord,
	SessionRecord,
} from "@wincode/agent-core";
import type { ChatModelSelection } from "@wincode/ai/models";
import { isUndefined } from "@wincode/utils";
import type { SessionMessage } from "@/modules/sessions/message";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	buildUserSessionRecord,
	projectSessionRecords,
	SessionRecordInvariantError,
} from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { SessionId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	attachmentId,
	modelId,
	sessionMessageId,
	sessionRecordId,
	toolCallId,
} from "../support/identifiers";

const model: ChatModelSelection = {
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
	store: SessionStore;
};

type CreatedSession = {
	id: SessionId;
	initialRecord: SessionRecord;
};

const createTestStore = async (): Promise<TestStore> => {
	const dir = await mkdtemp(join(tmpdir(), "wincode-conversation-record-"));
	const databasePath = join(dir, "conversation.sqlite");
	const { db } = createDatabase(databasePath);
	const store = createDrizzleSessionStore(db, {
		attachmentRoot: join(dir, "attachments"),
	});
	return { databasePath, store };
};

const createSession = async (
	store: SessionStore,
	text = "hello"
): Promise<CreatedSession> => {
	const { id } = await store.createSession({
		agent: agentId("build"),
		message: userMessage(text),
		model,
		turnId: agentTurnId(`turn-initial-${text}`),
	});
	const [initialRecord] = await store.listSessionRecords(id);
	if (isUndefined(initialRecord)) {
		throw new Error("The initial user record was not persisted.");
	}
	return { id, initialRecord };
};

test("creates an SDK-ready empty Session without inventing a user Submission", async () => {
	const { store } = await createTestStore();
	const { id } = await store.createEmptySession({ model });

	expect(await store.listSessionRecords(id)).toEqual([]);
	expect(await store.getSession(id)).toMatchObject({
		id,
		lastMessageAt: null,
		model,
		title: "Untitled Session",
	});
});

test("persists the accepted user message as an ordinary record", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store, "first");

	expect(initialRecord.outcome).toEqual({ kind: "user" });
	expect(initialRecord.messages).toEqual([
		{
			id: sessionMessageId("msg-user"),
			parts: [{ text: "first", type: "text" }],
			role: "user",
		},
	]);
	expect(await store.listSessionRecords(id)).toEqual([initialRecord]);
});
test("round-trips the logical user link for retried assistant rows", async () => {
	const { store } = await createTestStore();
	const { id } = await createSession(store);
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

	await store.commitSessionRecord({
		record: retriedRecord,
		sessionId: id,
	});

	const records = await store.listSessionRecords(id);
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
	const { databasePath, store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const assistant = assistantRecord("record-assistant", "done");
	await store.commitSessionRecord({ record: assistant, sessionId: id });

	const { db } = createDatabase(databasePath);
	const reopened = createDrizzleSessionStore(db, {
		attachmentRoot: join(tmpdir(), "wincode-reopened-attachments"),
	});

	expect(await reopened.listSessionRecords(id)).toEqual([
		initialRecord,
		assistant,
	]);
});

test("round-trips assistant and tool records independently", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const tool = toolRecord("record-tool");
	const assistant = assistantRecord("record-assistant", "tool result");

	await store.commitSessionRecord({ record: tool, sessionId: id });
	await store.commitSessionRecord({ record: assistant, sessionId: id });

	expect(await store.listSessionRecords(id)).toEqual([
		initialRecord,
		tool,
		assistant,
	]);
});

test("persists an optional Plugin tool without adding a built-in tool name", async () => {
	const { store } = await createTestStore();
	const { id } = await createSession(store);
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

	await store.commitSessionRecord({ record: pluginRecord, sessionId: id });

	const storedTool = projectSessionRecords(
		await store.listSessionRecords(id)
	)[1]?.parts[0];
	expect(storedTool).toMatchObject({
		toolName: "jira:create_issue",
		type: "dynamic-tool",
	});
});

test("round-trips a failed assistant record with its safe failure", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const record = failedRecord("record-failed");

	await store.commitSessionRecord({ record, sessionId: id });

	expect(await store.listSessionRecords(id)).toEqual([initialRecord, record]);
});

test("round-trips a cancelled assistant record without an interrupted badge", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const record = cancelledRecord("record-cancelled");

	await store.commitSessionRecord({ record, sessionId: id });

	expect(await store.listSessionRecords(id)).toEqual([initialRecord, record]);
	expect(projectSessionRecords([record])[0]?.metadata).toEqual({
		agent: agentId("build"),
		model,
		terminalOutcome: "cancelled",
	});
});

test("reopening a record drops an unsupported Reasoning Mode but preserves valid metadata", () => {
	const record: SessionRecord = {
		...assistantRecord("record-unsupported-mode", "done"),
		messages: [
			messageRecord("assistant-unsupported-mode", "assistant", "done", {
				agent: agentId("build"),
				model,
				reasoningMode: "thinking",
				usage: { inputTokens: 10, outputTokens: 5 },
			}),
		],
	};

	expect(projectSessionRecords([record])[0]?.metadata).toEqual({
		agent: agentId("build"),
		model,
		usage: { inputTokens: 10, outputTokens: 5 },
	});
});

test("keeps records isolated per session and per workspace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "wincode-conversation-record-"));
	const databasePath = join(dir, "conversation.sqlite");
	const { db } = createDatabase(databasePath);
	const firstWorkspace = createDrizzleSessionStore(db, {
		attachmentRoot: join(dir, "attachments-a"),
		workspaceRoot: join(dir, "workspace-a"),
	});
	const secondWorkspace = createDrizzleSessionStore(db, {
		attachmentRoot: join(dir, "attachments-b"),
		workspaceRoot: join(dir, "workspace-b"),
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
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const first = assistantRecord("record-1", "one");
	const second = assistantRecord("record-2", "two");
	const third = failedRecord("record-3");

	await Promise.all([
		store.commitSessionRecord({ record: first, sessionId: id }),
		store.commitSessionRecord({ record: second, sessionId: id }),
		store.commitSessionRecord({ record: third, sessionId: id }),
	]);

	expect(await store.listSessionRecords(id)).toEqual([
		initialRecord,
		first,
		second,
		third,
	]);
});

test("rejects malformed records without partial durable state", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const malformed: SessionRecord = fromAny({
		...assistantRecord("record-invalid", "bad"),
		outcome: { kind: "assistant", terminal: { finishedAt: 1, kind: "failed" } },
	});

	await expect(
		store.commitSessionRecord({ record: malformed, sessionId: id })
	).rejects.toBeInstanceOf(SessionRecordInvariantError);
	expect(await store.listSessionRecords(id)).toEqual([initialRecord]);

	await store.commitSessionRecord({
		record: assistantRecord("record-valid", "good"),
		sessionId: id,
	});
	expect(await store.listSessionRecords(id)).toHaveLength(2);
});

test("deletes Conversation Records with their session", async () => {
	const { store } = await createTestStore();
	const { id } = await createSession(store);
	await store.commitSessionRecord({
		record: assistantRecord("record-1", "hello"),
		sessionId: id,
	});

	await store.deleteSession(id);

	expect(await store.listSessionRecords(id)).toEqual([]);
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

test("round-trips the Agent Turn a Steering Message joined", async () => {
	const { store } = await createTestStore();
	const { id } = await createSession(store);
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
	await store.commitSessionRecord({ record: steering, sessionId: id });

	const records = await store.listSessionRecords(id);
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
