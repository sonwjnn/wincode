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
import type { SessionMessage } from "@/modules/sessions/message";
import { createDatabase } from "./client";
import { createDrizzleSessionStore } from "./drizzle-session-store";
import {
	buildUserSessionRecord,
	projectSessionRecords,
	SessionRecordInvariantError,
} from "./session-record";
import type { SessionStore } from "./session-store";

const model: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};

const userMessage = (text: string, id = "msg-user"): SessionMessage => ({
	id,
	parts: [{ text, type: "text" }],
	role: "user",
});

const messageRecord = (
	id: string,
	role: "assistant" | "user",
	text: string,
	metadata?: SessionMessageRecord["metadata"]
): SessionMessageRecord => ({
	id,
	...(metadata === undefined ? {} : { metadata }),
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
	agentId: "build",
	id,
	messages: [
		messageRecord(id.replace("record", "assistant"), "assistant", text, {
			agent: "build",
			model,
		}),
	],
	model,
	outcome: { kind: "assistant", terminal },
	turnId: `turn-${id}`,
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
	agentId: "build",
	id,
	messages: [
		{
			id: `tool-${id}`,
			parts: [
				{
					input: { command: "git status" },
					outcome: { kind: "success", output: { exitCode: 0 } },
					sequence: 1,
					toolCallId: `call-${id}`,
					toolName: "shell",
					type: "tool-call",
				},
			],
			role: "assistant",
		},
	],
	model,
	outcome: { kind: "tool" },
	turnId: `turn-${id}`,
	version: 1,
});

type TestStore = {
	databasePath: string;
	store: SessionStore;
};

type CreatedSession = {
	id: string;
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
		agent: "build",
		message: userMessage(text),
		model,
		turnId: `turn-initial-${text}`,
	});
	const [initialRecord] = await store.listSessionRecords(id);
	if (initialRecord === undefined) {
		throw new Error("The initial user record was not persisted.");
	}
	return { id, initialRecord };
};

test("persists the accepted user message as an ordinary record", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store, "first");

	expect(initialRecord.outcome).toEqual({ kind: "user" });
	expect(initialRecord.messages).toEqual([
		{
			id: "msg-user",
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
	if (message === undefined) {
		throw new Error("The assistant record did not contain a message.");
	}
	const retriedRecord: SessionRecord = {
		...assistant,
		messages: [
			{
				...message,
				metadata: {
					...message.metadata,
					sourceUserMessageId: "msg-user",
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
		"msg-user"
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

test("round-trips delegated correlation independently from the parent turn", async () => {
	const { store } = await createTestStore();
	const { id, initialRecord } = await createSession(store);
	const record: SessionRecord = {
		...assistantRecord("record-subagent", "delegated result"),
		agentId: "research",
		delegation: { parentToolCallId: "call-1", parentTurnId: "turn-parent" },
	};

	await store.commitSessionRecord({ record, sessionId: id });

	expect(await store.listSessionRecords(id)).toEqual([initialRecord, record]);
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
		agent: "build",
		model,
		terminalOutcome: "cancelled",
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

test("projects each ordinary row with references, metadata, and stable delegation ids", () => {
	const attachmentId = `v1-${"a".repeat(64)}`;
	const userRecord: SessionRecord = {
		agentId: "build",
		id: "record-user",
		messages: [
			{
				id: "user-1",
				metadata: {
					agent: "build",
					model,
					skill: {
						arguments: "focus",
						contentHash: "hash-1",
						name: "review",
						source: "explicit",
					},
				},
				parts: [
					{ text: "Review this file", type: "text" },
					{
						attachmentId,
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
		turnId: "turn-user",
		version: 1,
	};
	const delegated = {
		...assistantRecord("record-delegated", "delegated result"),
		agentId: "research",
		delegation: { parentToolCallId: "call-1", parentTurnId: "turn-parent" },
	};
	const primaryAssistant = assistantRecord("record-primary", "parent result");

	const projected = projectSessionRecords([
		userRecord,
		delegated,
		primaryAssistant,
	]);
	const [user, , delegatedAssistant] = projected;
	expect(projected.map(({ id }) => id)).toEqual([
		"user-1",
		"assistant-primary",
		"delegated-turn:turn-record-delegated:0:assistant-delegated",
	]);
	expect(user).toMatchObject({
		id: "user-1",
		metadata: {
			agent: "build",
			model,
			skill: {
				arguments: "focus",
				contentHash: "hash-1",
				name: "review",
				source: "explicit",
			},
		},
	});
	expect(user?.parts).toContainEqual({
		attachmentId,
		byteLength: 3,
		filename: "notes.txt",
		mediaType: "text/plain",
		type: "file",
		url: `attachment://${attachmentId}`,
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
	expect(delegatedAssistant?.id).toBe(
		"delegated-turn:turn-record-delegated:0:assistant-delegated"
	);
});

test("persists delegated child prompts as correlated user rows", async () => {
	const { store } = await createTestStore();
	const { id } = await createSession(store);
	const delegation = {
		parentToolCallId: "call-parent",
		parentTurnId: "turn-parent",
	};
	const record = buildUserSessionRecord({
		agentId: "subagent",
		delegation,
		message: userMessage("child prompt", "child-user"),
		model,
		turnId: "child-turn",
	});

	await store.commitSessionRecord({ record, sessionId: id });

	expect(await store.listSessionRecords(id)).toContainEqual(record);
	expect(projectSessionRecords([record])).toEqual([
		{
			id: "delegated-turn:child-turn:0:child-user",
			metadata: { agent: "subagent", model },
			parts: [{ text: "child prompt", type: "text" }],
			role: "user",
		},
	]);
});

test("projects a failed assistant row as its safe transcript message", () => {
	const projected = projectSessionRecords([failedRecord("record-failed")]);

	expect(projected).toEqual([
		{
			id: "assistant-failed",
			metadata: {
				agent: "build",
				model,
				terminalOutcome: "failed",
			},
			parts: [{ text: failure.message, type: "text" }],
			role: "assistant",
		},
	]);
});
